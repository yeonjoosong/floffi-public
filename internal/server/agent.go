package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"floffi/internal/server/auth"
)

// loadOwnerMemoriesForPrompt fetches the workspace owner's memory rows that
// apply to this workspace (global + workspace-scoped union) and returns them
// as content-only strings ready for prompt assembly. Returns nil on any
// failure — memory injection is best-effort, never blocks an agent run.
//
// Lookup runs via the workspace owner intentionally: auto-triggered paths
// (webhook ingest, schedule, workflow next-step) have no caller user
// context, so attributing the memories to the owner keeps the rule "내
// 워크스페이스에서 일어나는 작업엔 내 메모리가 적용된다" consistent across
// manual and automated triggers.
func loadOwnerMemoriesForPrompt(ctx context.Context, authStore *auth.Store, workspaceID string) []string {
	if authStore == nil || workspaceID == "" {
		return nil
	}
	ws, err := authStore.FindWorkspaceByID(ctx, workspaceID)
	if err != nil || ws == nil {
		return nil
	}
	rows, err := authStore.ListUserMemoriesForPrompt(ctx, ws.OwnerID, workspaceID)
	if err != nil || len(rows) == 0 {
		return nil
	}
	out := make([]string, 0, len(rows))
	for _, m := range rows {
		c := strings.TrimSpace(m.Content)
		if c != "" {
			out = append(out, c)
		}
	}
	return out
}

// loadRAGHitsForPrompt runs the FTS5 retrieval that gets injected into the
// agent prompt. Returns nil (no header rendered) when:
//
//   - the task has no usable query terms,
//   - the workspace has no approved content yet,
//   - or the DB call fails. RAG is best-effort and never blocks an agent run.
//
// Filtering policy:
//   - minTrust = 0.7  — only approved reports + user-authored vault docs
//     reach the prompt (옵션 C)
//   - top-K = 5
//   - total inject budget = 4KB (truncate longer snippets)
//   - workflow tasks only retrieve at step 0; later steps see retrieval
//     via AccContext to keep per-task LLM cost predictable
func loadRAGHitsForPrompt(ctx context.Context, authStore *auth.Store, workspaceID string, task workspaceTask) []ragHit {
	if authStore == nil || workspaceID == "" {
		return nil
	}
	if task.WorkflowEnabled && task.WorkflowStep > 0 {
		return nil
	}
	query := strings.TrimSpace(task.Title + " " + task.Description)
	if query == "" {
		return nil
	}
	// Per-token OR match, each token quoted (search_api.go와 같은 escape 규칙).
	// 이전엔 쿼리 전체를 단일 phrase로 묶었는데, 그러면 알람 제목
	// ("[ERROR] simscan@mx01 · [simscan] scan delay 250.00s on mx01") 전체가
	// 연속으로 등장하는 문서만 매칭 → runbook/vault 문서가 사실상 영원히
	// 검색되지 않았다. 토큰 OR + bm25 랭킹이면 "simscan", "delay" 등 핵심
	// 용어를 공유하는 runbook이 상위로 올라온다.
	matchExpr := ragMatchExpr(query)
	if matchExpr == "" {
		return nil
	}
	hits, err := authStore.SearchWorkspace(ctx, workspaceID, matchExpr, 0.7, 5)
	if err != nil || len(hits) == 0 {
		return nil
	}
	const budget = 4 * 1024
	used := 0
	out := make([]ragHit, 0, len(hits))
	for _, h := range hits {
		snippet := h.Snippet
		title := h.Title
		entry := len(title) + len(snippet) + 32 // ~bracket / id overhead
		if used+entry > budget {
			break
		}
		used += entry
		out = append(out, ragHit{
			SourceType: h.SourceType,
			SourceID:   h.SourceID,
			Title:      title,
			Snippet:    snippet,
		})
	}
	return out
}

// hasRunbookHit reports whether any injected RAG hit is a runbook — a vault
// doc whose title contains "runbook"/"런북". Used to switch on the
// runbook-priority prompt block so the model follows the documented procedure
// (correct engine names, real check commands) instead of generic guessing.
func hasRunbookHit(hits []ragHit) bool {
	for _, h := range hits {
		if h.SourceType != "vault" {
			continue
		}
		t := strings.ToLower(h.Title)
		if strings.Contains(t, "runbook") || strings.Contains(t, "런북") {
			return true
		}
	}
	return false
}

// ragMatchExpr turns free text into a safe FTS5 OR-query: each whitespace
// token is individually quoted (so FTS5 operators/punctuation inside tokens
// stay literal) and joined with OR. Tokens are deduped and capped to keep the
// query bounded; 1-rune tokens are dropped as noise ("·", "on", 단음절 조사 등은
// bm25 변별력이 없다).
func ragMatchExpr(query string) string {
	const maxTerms = 24
	seen := map[string]bool{}
	terms := make([]string, 0, maxTerms)
	for _, tok := range strings.Fields(query) {
		if len([]rune(tok)) < 2 || seen[tok] {
			continue
		}
		seen[tok] = true
		terms = append(terms, `"`+strings.ReplaceAll(tok, `"`, `""`)+`"`)
		if len(terms) >= maxTerms {
			break
		}
	}
	return strings.Join(terms, " OR ")
}

// ── LLM Rate Limiter ──────────────────────────────────────────────────────────
//
// llmRateLimiter enforces a minimum gap between consecutive LLM API calls to
// stay within the provider's RPM (requests per minute) quota.
//
// The default limit is read from the LLM_RPM_LIMIT environment variable.
// If unset, it defaults to 10 RPM (6 s gap) — a conservative value that works
// safely with Gemini free-tier and most OpenAI tier-1 accounts.
//
// All callers (webhook workflow goroutine AND manual task runs) share the same
// limiter instance so concurrent calls don't collectively exceed the quota.

type llmRateLimiter struct {
	mu       sync.Mutex
	lastSent time.Time
	gap      time.Duration // minimum gap between calls = 60s / RPM
}

func newLLMRateLimiter() *llmRateLimiter {
	// Default is 8 RPM, slightly under Gemini free tier's ~10 RPM so we never
	// hit a 429 from the upstream's own minute window. Override with
	// LLM_RPM_LIMIT for paid tiers.
	rpm := 8
	if v := os.Getenv("LLM_RPM_LIMIT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			rpm = n
		}
	}
	return &llmRateLimiter{gap: time.Minute / time.Duration(rpm)}
}

// Wait blocks until at least gap has elapsed since the previous call, then
// reserves the next slot. Returns ctx.Err() if context is cancelled while
// waiting.
func (r *llmRateLimiter) Wait(ctx context.Context) error {
	r.mu.Lock()
	now := time.Now()
	next := r.lastSent.Add(r.gap)
	wait := next.Sub(now)
	if wait < 0 {
		wait = 0
	}
	// Reserve the slot before releasing the lock so concurrent callers queue up.
	r.lastSent = now.Add(wait)
	r.mu.Unlock()

	if wait == 0 {
		return nil
	}
	select {
	case <-time.After(wait):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ── BYOK key plumbing ─────────────────────────────────────────────────────────
//
// When a request carries an X-LLM-Key header, the middleware stashes it on the
// request context. Provider call functions look in the context first, then
// fall back to the env-var key.
//
// The key never crosses package boundaries except through this context value;
// it is never logged, persisted, or echoed back in responses.

type llmKeyCtxKey struct{}

func withLLMKey(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, llmKeyCtxKey{}, key)
}

func llmKeyFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(llmKeyCtxKey{}).(string); ok {
		return v
	}
	return ""
}

// resolveAPIKey prefers a user-supplied (BYOK) key from context and falls back
// to the named environment variable. Empty string means "no key available".
func resolveAPIKey(ctx context.Context, envVar string) string {
	if k := llmKeyFromContext(ctx); k != "" {
		return k
	}
	return os.Getenv(envVar)
}

// ── Daily Call Quota ──────────────────────────────────────────────────────────
//
// dailyQuota caps the total number of LLM API calls per calendar day, server-
// wide. This is the runtime safety net against billing surprises — even if
// every other guard (per-task retry cap, watchdog, manual restart loop) fails,
// no more than `limit` real upstream calls go out per day.
//
// The limit is read from LLM_DAILY_CALL_LIMIT (default 500). Counter resets
// at local-time midnight; lives in memory only (resets on server restart,
// which is fine — the hard cap is the provider/billing side).

type dailyQuota struct {
	mu    sync.Mutex
	date  string
	count int
	limit int
}

func newDailyQuota() *dailyQuota {
	// Default 200/day stays below Gemini free tier's ~250 RPD on gemini-2.5-flash,
	// reserving a small buffer for retries and the watchdog goroutines. Bump
	// with LLM_DAILY_CALL_LIMIT for paid keys.
	limit := 200
	if v := os.Getenv("LLM_DAILY_CALL_LIMIT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	return &dailyQuota{limit: limit, date: time.Now().Format("2006-01-02")}
}

// tryConsume reserves one call slot. Returns (used, limit, ok).
// ok=false means the daily limit has been reached for today.
func (q *dailyQuota) tryConsume() (used, limit int, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	today := time.Now().Format("2006-01-02")
	if today != q.date {
		q.date = today
		q.count = 0
	}
	if q.count >= q.limit {
		return q.count, q.limit, false
	}
	q.count++
	return q.count, q.limit, true
}

// ── runAgentTask ──────────────────────────────────────────────────────────────

// runAgentTask dispatches to the correct LLM provider based on the enabled workspace provider.
// Provider routing:
//
//	id "anthropic" → ANTHROPIC_API_KEY (claude-*)
//	id "openai"    → OPENAI_API_KEY    (o4-mini / codex-mini-latest)
//	id "gemini"    → GEMINI_API_KEY    (gemini-2.5-flash)
//
// Falls back to auto-detect if no provider matches.
// lim enforces the global RPM cap before the HTTP call is made.
// quota enforces the daily total-calls cap (cost ceiling).
// On rate-limit errors the retry waits ≥ 65 s; on other transient errors it
// uses 2 s → 4 s → 8 s exponential backoff (max 5 attempts).
func runAgentTask(ctx context.Context, task workspaceTask, agent workspaceAgent, team workspaceTeam, provider workspaceProvider, lim *llmRateLimiter, quota *dailyQuota, store *workspaceStore, authStore *auth.Store) (string, error) {
	attachmentBlock := collectAttachmentsForPrompt(store, task)
	// Settings.DisplayName lets the user override the legacy "보스" honorific.
	// Empty falls back to "보스" inside buildAgentPrompt.
	userLabel := store.snapshot().Settings.DisplayName
	// Stage 1: per-user long-term memory. Looked up by workspace owner so
	// webhook-triggered runs (no caller user context) still pick up the
	// memories of whoever owns the workspace — matches the mental model
	// "내 워크스페이스에서 일어나는 작업엔 내 메모리가 적용된다".
	userMemories := loadOwnerMemoriesForPrompt(ctx, authStore, store.workspaceID)
	// Stage 1-C: FTS5 RAG. Query = task.Title + Description (the same brief
	// the model is about to act on). Workflow tasks search exactly once at
	// step 0 — later steps inherit via AccContext, so they skip retrieval
	// to keep the per-task LLM cost predictable.
	ragHits := loadRAGHitsForPrompt(ctx, authStore, store.workspaceID, task)
	prompt := buildAgentPrompt(task, agent, team, attachmentBlock, userLabel, userMemories, ragHits)
	// Collect input images once — both the text and image paths feed them
	// straight into the multimodal request. Non-image attachments stay in
	// the prompt as metadata via collectAttachmentsForPrompt above.
	images, imagesTruncated := store.collectImagePartsForPrompt(task.ID, task.Attachments)
	if imagesTruncated {
		prompt += "\n\n(참고: 첨부 이미지 일부가 용량 한도(18MB)를 초과하여 모델에 전달되지 못했습니다.)"
	}
	started := time.Now()
	logger.Info("[agent] task start",
		"task", task.ID, "title", truncate(task.Title, 40), "provider", provider.ID,
		"model", provider.Model, "promptBytes", len(prompt), "images", len(images), "imageOutput", task.ImageOutput)

	// Image-output mode: route to Gemini's image model regardless of which
	// provider the workspace has selected — other providers don't have a
	// drop-in equivalent. The generated PNG is saved as a task attachment
	// before the boss report text is returned.
	if task.ImageOutput {
		return runImageGenTask(ctx, task, prompt, images, lim, quota, store)
	}

	call := func() (string, error) {
		// Daily call cap — refuse before any upstream work happens.
		used, limit, ok := quota.tryConsume()
		if !ok {
			logger.Warn("[quota] daily LLM call cap reached — refusing call", "used", used, "limit", limit)
			return "", fmt.Errorf("floffi daily LLM call cap reached (%d/%d) — try again tomorrow", used, limit)
		}
		logger.Info("[quota] usage", "used", used, "limit", limit)
		// Enforce RPM cap before every attempt (including retries).
		if err := lim.Wait(ctx); err != nil {
			return "", err
		}
		switch strings.ToLower(provider.ID) {
		case "anthropic":
			return callAnthropic(ctx, prompt, resolveModel(provider.Model, "claude-sonnet-4-5-20251001"))
		case "openai":
			return callOpenAI(ctx, prompt, resolveModel(provider.Model, "o4-mini"))
		case "gemini":
			return callGemini(ctx, prompt, resolveModel(provider.Model, "gemini-2.5-flash"), images)
		default:
			return autoDetect(ctx, prompt)
		}
	}

	out, err := withRetry(ctx, 5, call)
	if err != nil {
		logger.Error("[agent] task FAILED", "task", task.ID, "after", time.Since(started).Round(time.Millisecond).String(), "err", err)
		return out, err
	}
	logger.Info("[agent] task done", "task", task.ID, "in", time.Since(started).Round(time.Millisecond).String(), "replyBytes", len(out))
	return out, nil
}

// allowedImageGridCounts are the only valid N values for the "single canvas
// with N variations" layout. Frontend offers these in a dropdown; anything
// else (0, negative, weird primes) is clamped to 1 = single image.
var allowedImageGridCounts = map[int]string{
	1:  "",
	4:  "2행 × 2열",
	6:  "2행 × 3열",
	9:  "3행 × 3열",
	10: "2행 × 5열",
	12: "3행 × 4열",
}

// gridInstructionFor returns a Korean prompt fragment that asks the image
// model to lay out N variations on a single canvas. Returns "" when no
// grid is requested (count <= 1 or unsupported value).
func gridInstructionFor(count int) string {
	layout, ok := allowedImageGridCounts[count]
	if !ok || layout == "" {
		return ""
	}
	return fmt.Sprintf(
		"\n\n## 출력 형식 (필수)\n"+
			"하나의 1024×1024 정사각형 캔버스 안에 서로 명확히 다른 %d개 변형을 %s 그리드로 균등 분할해 배치하세요. "+
			"각 셀 사이에는 얇은 여백을 두고, 셀마다 짧은 라벨(번호 또는 단어)을 작게 표시하세요. "+
			"같은 변형을 반복하지 말고, 형태·색·디테일이 충분히 구별되도록 다양화하세요. "+
			"최종 응답은 *그리드 1장으로 합쳐진 한 장의 이미지*만 반환하세요 (분리된 여러 장 X).\n",
		count, layout,
	)
}

// runImageGenTask hits gemini-2.5-flash-image, saves the returned PNG/JPEG as
// a fresh attachment on the same task, and returns a short boss-report body.
// We deliberately skip the withRetry wrapper here — image generation
// regressions (safety, blank output) repeat deterministically, so retrying
// just burns quota.
func runImageGenTask(ctx context.Context, task workspaceTask, prompt string, images []ImagePart, lim *llmRateLimiter, quota *dailyQuota, store *workspaceStore) (string, error) {
	used, limit, ok := quota.tryConsume()
	if !ok {
		return "", fmt.Errorf("floffi daily LLM call cap reached (%d/%d) — try again tomorrow", used, limit)
	}
	logger.Info("[quota] usage (image gen)", "used", used, "limit", limit)
	if err := lim.Wait(ctx); err != nil {
		return "", err
	}

	// Append the grid instruction last so it overrides any earlier hints
	// the user might have put in their description ("draw 10 variations").
	// The model reliably follows the most recent layout directive.
	finalPrompt := prompt + gridInstructionFor(task.ImageGridCount)
	result, err := callGeminiImage(ctx, finalPrompt, "gemini-2.5-flash-image", images)
	if err != nil {
		userMsg := mapGeminiImageError(err)
		logger.Error("[agent] image gen task FAILED", "task", task.ID, "err", err, "userFacing", userMsg)
		// Surface the user-facing Korean message; the existing error-handler
		// pipeline shows it via the workspace banner or toast.
		return "", fmt.Errorf("%s", userMsg)
	}

	// Persist the generated image as an attachment so it shows up in the UI
	// inline next to the report.
	att, saveErr := store.saveGeneratedImage(task.ID, result.MIME, result.Data)
	if saveErr != nil {
		return "", fmt.Errorf("이미지 저장 실패: %w", saveErr)
	}

	var report strings.Builder
	report.WriteString("## 이미지 생성 결과\n\n")
	if layout, ok := allowedImageGridCounts[task.ImageGridCount]; ok && layout != "" {
		report.WriteString(fmt.Sprintf("요청에 따라 한 장의 캔버스에 %d개 변형(%s 그리드)을 담아 생성했습니다 (`%s`, %d bytes). 보드의 보고서에서 미리보기로 확인할 수 있습니다.\n",
			task.ImageGridCount, layout, att.Name, att.Size))
	} else {
		report.WriteString(fmt.Sprintf("요청에 따라 이미지 한 장을 생성했습니다 (`%s`, %d bytes). 보드의 보고서에서 미리보기로 확인할 수 있습니다.\n",
			att.Name, att.Size))
	}
	if result.Caption != "" {
		report.WriteString("\n### 모델 코멘트\n")
		report.WriteString(result.Caption)
		report.WriteString("\n")
	}
	return report.String(), nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// ── Retry with smart backoff ──────────────────────────────────────────────────

// withRetry calls fn up to maxAttempts times, retrying only on transient errors.
// Backoff strategy:
//   - Rate-limit errors (429 / quota exhausted): wait 65 s to let the RPM
//     window reset before retrying.
//   - Other transient errors (503, overloaded…): 2 s → 4 s → 8 s exponential.
func withRetry(ctx context.Context, maxAttempts int, fn func() (string, error)) (string, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			wait := backoffFor(lastErr, attempt)
			logger.Warn("[agent] retry", "attempt", attempt+1, "max", maxAttempts, "after", wait.Round(time.Millisecond).String(), "lastErr", lastErr)
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		result, err := fn()
		if err == nil {
			return result, nil
		}
		lastErr = err
		if !isTransientError(err) {
			logger.Error("[agent] permanent error (no retry)", "err", err)
			return "", err
		}
	}
	return "", lastErr
}

// backoffFor returns the wait duration before the next retry attempt.
//
// Rate-limit errors: parse "retry in Xs" from the provider's error message and
// wait that long + 3 s buffer. Falls back to 65 s if no value is found.
// Other transient errors: 2 s → 4 s → 8 s → 16 s exponential.
func backoffFor(err error, attempt int) time.Duration {
	if isRateLimitError(err) {
		if d := parseRetryAfter(err); d > 0 {
			return d + 3*time.Second // parsed value + small buffer
		}
		return 65 * time.Second // fallback
	}
	// 2s, 4s, 8s, 16s …
	return time.Duration(2<<uint(attempt-1)) * time.Second
}

// parseRetryAfter extracts the suggested retry delay from a provider error
// message. Gemini returns strings like "Please retry in 15.957446758s".
// Returns 0 if no value can be parsed.
func parseRetryAfter(err error) time.Duration {
	if err == nil {
		return 0
	}
	msg := err.Error()
	// Look for "retry in <float>s" pattern (case-insensitive).
	lower := strings.ToLower(msg)
	idx := strings.Index(lower, "retry in ")
	if idx < 0 {
		return 0
	}
	rest := msg[idx+len("retry in "):]
	// Extract the numeric portion up to the first non-digit / non-dot character.
	end := 0
	for end < len(rest) && (rest[end] >= '0' && rest[end] <= '9' || rest[end] == '.') {
		end++
	}
	if end == 0 {
		return 0
	}
	secs, err2 := strconv.ParseFloat(rest[:end], 64)
	if err2 != nil || secs <= 0 {
		return 0
	}
	return time.Duration(secs * float64(time.Second))
}

// isTransientError returns true for errors that are worth retrying.
func isTransientError(err error) bool {
	return isRateLimitError(err) || isServerOverloadError(err)
}

// isRateLimitError detects HTTP 429 / quota-exhausted responses from any provider.
func isRateLimitError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, kw := range []string{
		"rate limit", "rate_limit", "ratelimit",
		"too many requests", "429",
		"quota", "resource_exhausted", "resource exhausted",
		"requests per minute", "rpm",
	} {
		if strings.Contains(msg, kw) {
			return true
		}
	}
	return false
}

// isServerOverloadError detects transient server-side errors (503, 529, etc.).
func isServerOverloadError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, kw := range []string{
		"high demand", "try again", "temporarily", "overloaded", "503", "529",
	} {
		if strings.Contains(msg, kw) {
			return true
		}
	}
	return false
}

// autoDetect tries OPENAI_API_KEY → GEMINI_API_KEY → ANTHROPIC_API_KEY in order.
func autoDetect(ctx context.Context, prompt string) (string, error) {
	if os.Getenv("OPENAI_API_KEY") != "" {
		return callOpenAI(ctx, prompt, "o4-mini")
	}
	if os.Getenv("GEMINI_API_KEY") != "" {
		return callGemini(ctx, prompt, "gemini-2.5-flash", nil)
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" {
		return callAnthropic(ctx, prompt, "claude-sonnet-4-5-20251001")
	}
	return "", fmt.Errorf("API 키가 설정되지 않았습니다. OPENAI_API_KEY, GEMINI_API_KEY, 또는 ANTHROPIC_API_KEY 중 하나를 설정해주세요")
}

func resolveModel(configured, fallback string) string {
	if configured == "" || configured == "auto" {
		return fallback
	}
	return configured
}

// ── OpenAI (Codex / o4-mini) ─────────────────────────────────────────────────

type openaiRequest struct {
	Model     string          `json:"model"`
	Messages  []openaiMessage `json:"messages"`
	MaxTokens int             `json:"max_completion_tokens,omitempty"`
}

type openaiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openaiResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func callOpenAI(ctx context.Context, prompt, model string) (string, error) {
	apiKey := resolveAPIKey(ctx, "OPENAI_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("OpenAI 키가 없습니다 (X-LLM-Key 헤더 또는 OPENAI_API_KEY 환경 변수 설정)")
	}

	reqBody := openaiRequest{
		Model:    model,
		Messages: []openaiMessage{{Role: "user", Content: prompt}},
		// o-series models don't accept max_tokens; use max_completion_tokens.
		// Set 0 to omit and let the model decide.
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	return doRequest[openaiResponse](req, func(r openaiResponse) (string, error) {
		if r.Error != nil {
			return "", fmt.Errorf("OpenAI API 오류: %s", r.Error.Message)
		}
		if len(r.Choices) == 0 || r.Choices[0].Message.Content == "" {
			return "", fmt.Errorf("OpenAI로부터 빈 응답을 받았습니다")
		}
		return r.Choices[0].Message.Content, nil
	})
}

// ── Google Gemini ─────────────────────────────────────────────────────────────

type geminiRequest struct {
	Contents []geminiContent `json:"contents"`
	Tools    []geminiTool    `json:"tools,omitempty"`
}

type geminiContent struct {
	Parts []geminiPart `json:"parts"`
	Role  string       `json:"role,omitempty"`
}

// geminiPart is a discriminated union: exactly one of Text / InlineData is set
// per element. omitempty ensures we don't ship empty fields that would confuse
// Gemini's strict schema validation.
type geminiPart struct {
	Text       string            `json:"text,omitempty"`
	InlineData *geminiInlineData `json:"inline_data,omitempty"`
}

type geminiInlineData struct {
	MimeType string `json:"mime_type"`
	// Data is base64-encoded bytes (no data: prefix, no newlines).
	Data string `json:"data"`
}

// geminiTool enables the built-in Google Search grounding so the model
// can fetch real-time information (weather, prices, hours, news, …)
// instead of refusing because it has no live data access.
type geminiTool struct {
	GoogleSearch *struct{} `json:"google_search,omitempty"`
}

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []geminiPart `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason,omitempty"`
	} `json:"candidates"`
	// promptFeedback carries safety blocks: when blockReason is set, the model
	// refused on safety grounds and Candidates will be empty.
	PromptFeedback *struct {
		BlockReason string `json:"blockReason,omitempty"`
	} `json:"promptFeedback,omitempty"`
	Error *struct {
		Code    int    `json:"code,omitempty"`
		Message string `json:"message,omitempty"`
		Status  string `json:"status,omitempty"`
	} `json:"error,omitempty"`
}

// buildGeminiParts assembles the user-turn parts for a Gemini request:
// images first (so the model sees them before the instructions reference
// them), then the text prompt. Each image becomes an inline_data part
// containing base64-encoded raw bytes.
func buildGeminiParts(prompt string, images []ImagePart) []geminiPart {
	parts := make([]geminiPart, 0, len(images)+1)
	for _, img := range images {
		parts = append(parts, geminiPart{
			InlineData: &geminiInlineData{
				MimeType: img.MIME,
				Data:     base64.StdEncoding.EncodeToString(img.Data),
			},
		})
	}
	parts = append(parts, geminiPart{Text: prompt})
	return parts
}

func callGemini(ctx context.Context, prompt, model string, images []ImagePart) (string, error) {
	apiKey := resolveAPIKey(ctx, "GEMINI_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("Gemini 키가 없습니다 (X-LLM-Key 헤더 또는 GEMINI_API_KEY 환경 변수 설정)")
	}

	// Auth via x-goog-api-key header (NOT URL ?key=…) so the key never appears
	// in transport errors, access logs, or any retry-after URL strings.
	endpoint := fmt.Sprintf(
		"https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent",
		model,
	)

	reqBody := geminiRequest{
		Contents: []geminiContent{{Parts: buildGeminiParts(prompt, images), Role: "user"}},
		Tools:    []geminiTool{{GoogleSearch: &struct{}{}}},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", apiKey)

	return doRequest[geminiResponse](req, func(r geminiResponse) (string, error) {
		if r.Error != nil {
			return "", fmt.Errorf("Gemini API 오류: %s", r.Error.Message)
		}
		if r.PromptFeedback != nil && r.PromptFeedback.BlockReason != "" {
			return "", fmt.Errorf("Gemini 안전성 차단: %s", r.PromptFeedback.BlockReason)
		}
		if len(r.Candidates) == 0 || len(r.Candidates[0].Content.Parts) == 0 {
			return "", fmt.Errorf("Gemini로부터 빈 응답을 받았습니다")
		}
		// Concatenate every text part — vision models occasionally split
		// their reply across multiple parts (e.g. text, then more text).
		var b strings.Builder
		for _, p := range r.Candidates[0].Content.Parts {
			if p.Text != "" {
				b.WriteString(p.Text)
			}
		}
		if b.Len() == 0 {
			return "", fmt.Errorf("Gemini로부터 텍스트 응답을 받지 못했습니다")
		}
		return b.String(), nil
	})
}

// GeminiImageResult is the structured output of callGeminiImage: the raw image
// bytes plus the MIME type the model returned, and any free-form text the
// model emitted alongside the image (often empty).
type GeminiImageResult struct {
	MIME    string
	Data    []byte
	Caption string
}

// callGeminiImage hits the image-generation endpoint
// (gemini-2.5-flash-image / "Nano Banana") and returns the first inline_data
// part it finds. Input images are forwarded as multimodal references so the
// user can say "use this screenshot as the visual style".
//
// All failure modes map to a small, user-friendly Korean message — the raw
// upstream text is kept inside the error chain but the caller is expected to
// wrap it again via mapGeminiImageError before showing it to the user.
func callGeminiImage(ctx context.Context, prompt, model string, images []ImagePart) (GeminiImageResult, error) {
	apiKey := resolveAPIKey(ctx, "GEMINI_API_KEY")
	if apiKey == "" {
		return GeminiImageResult{}, fmt.Errorf("Gemini 키가 없습니다 (X-LLM-Key 헤더 또는 GEMINI_API_KEY 환경 변수 설정)")
	}

	endpoint := fmt.Sprintf(
		"https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent",
		model,
	)

	// Image models don't accept the google_search tool — sending it produces
	// a 400. Plain contents only.
	reqBody := geminiRequest{
		Contents: []geminiContent{{Parts: buildGeminiParts(prompt, images), Role: "user"}},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return GeminiImageResult{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return GeminiImageResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return GeminiImageResult{}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return GeminiImageResult{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Trim large bodies so logs stay readable; mapGeminiImageError only
		// pattern-matches against well-known substrings.
		snippet := string(respBody)
		if len(snippet) > 500 {
			snippet = snippet[:500] + "…"
		}
		return GeminiImageResult{}, fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet)
	}

	var r geminiResponse
	if err := json.Unmarshal(respBody, &r); err != nil {
		return GeminiImageResult{}, fmt.Errorf("Gemini 응답 파싱 실패: %w", err)
	}
	if r.Error != nil {
		return GeminiImageResult{}, fmt.Errorf("Gemini API 오류: %s", r.Error.Message)
	}
	if r.PromptFeedback != nil && r.PromptFeedback.BlockReason != "" {
		return GeminiImageResult{}, fmt.Errorf("Gemini 안전성 차단: %s", r.PromptFeedback.BlockReason)
	}
	if len(r.Candidates) == 0 {
		return GeminiImageResult{}, fmt.Errorf("Gemini로부터 빈 응답을 받았습니다")
	}

	var caption strings.Builder
	var imgPart *geminiInlineData
	for _, p := range r.Candidates[0].Content.Parts {
		if p.InlineData != nil && imgPart == nil &&
			strings.HasPrefix(p.InlineData.MimeType, "image/") {
			imgPart = p.InlineData
		} else if p.Text != "" {
			caption.WriteString(p.Text)
		}
	}
	if imgPart == nil {
		return GeminiImageResult{}, fmt.Errorf("image_not_generated")
	}
	raw, derr := base64.StdEncoding.DecodeString(imgPart.Data)
	if derr != nil {
		return GeminiImageResult{}, fmt.Errorf("Gemini 응답의 이미지 디코딩 실패: %w", derr)
	}
	return GeminiImageResult{MIME: imgPart.MimeType, Data: raw, Caption: caption.String()}, nil
}

// mapGeminiImageError takes the low-level error from callGeminiImage and
// returns a user-friendly Korean message. The raw error stays in server logs;
// only this short form is surfaced to the UI.
func mapGeminiImageError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "image_not_generated"):
		return "이번 요청에서는 이미지 결과가 생성되지 않았습니다. 다시 시도해주세요."
	case strings.Contains(msg, "안전성 차단"),
		strings.Contains(strings.ToLower(msg), "safety"):
		return "안전성 정책에 의해 이미지 생성이 거부되었습니다. 다른 표현으로 재시도해주세요."
	case strings.Contains(msg, "429"),
		strings.Contains(strings.ToLower(msg), "rate"),
		strings.Contains(strings.ToLower(msg), "quota"):
		return "Gemini API 한도에 도달했습니다. 잠시 후 다시 시도해주세요."
	case strings.Contains(msg, "키가 없습니다"),
		strings.Contains(msg, "API 키가 설정되지 않았습니다"):
		// Let the existing missing-key toast path handle this.
		return msg
	case strings.Contains(msg, "503"), strings.Contains(msg, "504"),
		strings.Contains(strings.ToLower(msg), "timeout"):
		return "이미지 생성 서비스가 일시적으로 응답하지 않습니다."
	case strings.Contains(msg, "400"), strings.Contains(msg, "401"),
		strings.Contains(msg, "403"):
		return "잘못된 요청입니다. API 키 또는 요청 형식을 확인해주세요."
	default:
		return "이미지 생성에 실패했습니다. 잠시 후 다시 시도해주세요."
	}
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	Messages  []anthropicMessage `json:"messages"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicResponse struct {
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func callAnthropic(ctx context.Context, prompt, model string) (string, error) {
	apiKey := resolveAPIKey(ctx, "ANTHROPIC_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("Anthropic 키가 없습니다 (X-LLM-Key 헤더 또는 ANTHROPIC_API_KEY 환경 변수 설정)")
	}

	reqBody := anthropicRequest{
		Model:     model,
		MaxTokens: 1024,
		Messages:  []anthropicMessage{{Role: "user", Content: prompt}},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	return doRequest[anthropicResponse](req, func(r anthropicResponse) (string, error) {
		if r.Error != nil {
			return "", fmt.Errorf("Anthropic API 오류: %s", r.Error.Message)
		}
		if len(r.Content) == 0 {
			return "", fmt.Errorf("Anthropic으로부터 빈 응답을 받았습니다")
		}
		return r.Content[0].Text, nil
	})
}

// ── shared HTTP helper ────────────────────────────────────────────────────────

func doRequest[T any](req *http.Request, extract func(T) (string, error)) (string, error) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	var parsed T
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("응답 파싱 오류 (HTTP %d): %w  body=%s", resp.StatusCode, err, snippet(respBody))
	}

	text, err := extract(parsed)
	if err != nil {
		// Always surface HTTP status + body snippet when extract fails on a non-2xx
		// response — prior behaviour swallowed the status which made debugging hard.
		if resp.StatusCode >= 400 {
			return "", fmt.Errorf("HTTP %d — %v  body=%s", resp.StatusCode, err, snippet(respBody))
		}
		return "", err
	}
	if text == "" && resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API HTTP %d: %s", resp.StatusCode, snippet(respBody))
	}
	return text, nil
}

func snippet(b []byte) string {
	const max = 500
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "…"
}

// ── prompt builder ────────────────────────────────────────────────────────────

// collectAttachmentsForPrompt reads each attachment's bytes from disk and
// formats them as a single block to be inlined into the agent prompt. Text
// content is included verbatim (with a per-file and combined cap); binary
// files only contribute a metadata line so the agent knows they exist but
// won't get a wall of garbled bytes.
//
// Returns an empty string when the task has no attachments, so the caller
// can omit the section entirely.
func collectAttachmentsForPrompt(store *workspaceStore, task workspaceTask) string {
	if store == nil || len(task.Attachments) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n## 첨부 파일\n")
	sb.WriteString("사용자가 다음 파일들을 업로드했습니다. 사용자의 요청(요약/분석/정리/수정/판정 등)에 따라 이 파일들의 내용을 근거로 작업하세요.\n\n")

	totalInlined := 0
	for i, att := range task.Attachments {
		sb.WriteString(fmt.Sprintf("### 파일 %d: %s\n", i+1, att.Name))
		sb.WriteString(fmt.Sprintf("- 크기: %d bytes\n- MIME: %s\n", att.Size, att.MIME))

		remaining := maxTotalInlinePromptKiB - totalInlined
		if remaining <= 0 {
			sb.WriteString("- (이전 파일들로 인라인 예산을 모두 사용하여 본문은 생략됨)\n\n")
			continue
		}
		text, truncated, isText := store.readAttachmentForPrompt(task.ID, att)
		if !isText {
			sb.WriteString("- (텍스트가 아닌 바이너리 파일 — 본문은 인라인하지 않음. 사용자가 명시적으로 요청하면 파일 종류/메타만 가지고 답변하세요.)\n\n")
			continue
		}
		if len(text) > remaining {
			text = text[:remaining]
			truncated = true
		}
		totalInlined += len(text)
		sb.WriteString("\n```\n")
		sb.WriteString(text)
		if !strings.HasSuffix(text, "\n") {
			sb.WriteString("\n")
		}
		sb.WriteString("```\n")
		if truncated {
			sb.WriteString("(파일 본문이 길어 일부만 표시됨)\n")
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

// ragHit is a trimmed view of auth.SearchHit, pre-truncated for the prompt.
// Keeping a server-package type lets buildAgentPrompt stay free of the auth
// import (one less coupling), and the body is already snippet-truncated by
// the time we get here.
type ragHit struct {
	SourceType string
	SourceID   string
	Title      string
	Snippet    string
}

func buildAgentPrompt(task workspaceTask, agent workspaceAgent, team workspaceTeam, attachmentBlock string, userLabel string, userMemories []string, ragHits []ragHit) string {
	// Honorific the agent addresses the user with — comes from
	// workspaceSettings.displayName; fall back to "보스" when unset.
	if userLabel == "" {
		userLabel = "보스"
	}
	var sb strings.Builder

	// Inject current date so the agent doesn't hallucinate a wrong date
	sb.WriteString(fmt.Sprintf("오늘 날짜: %s (KST)\n\n", time.Now().In(time.FixedZone("KST", 9*60*60)).Format("2006-01-02")))

	// Stage 1 of plan/rag-and-memory-roadmap.md — user-scoped long-term memory.
	// Sits *above* the agent persona + task brief so a contradiction resolves in
	// the user's favor (priority table: 시스템 안전 규칙 > 사용자 메모리 > 태스크).
	// Empty slice means "no memories applicable to this user/workspace" — skip
	// the section so the prompt doesn't carry a dangling header.
	if len(userMemories) > 0 {
		sb.WriteString("## 사용자 메모리\n")
		sb.WriteString(fmt.Sprintf("아래는 %s가 이전에 명시적으로 기억해두라고 한 지시 사항입니다. ", userLabel))
		sb.WriteString("이번 응답에서 충돌하는 부분이 있으면 시스템 안전 규칙을 제외하고는 이 메모리를 우선해서 따르세요.\n\n")
		for _, m := range userMemories {
			sb.WriteString("- ")
			sb.WriteString(m)
			sb.WriteString("\n")
		}
		sb.WriteString("\n")
	}

	sb.WriteString("당신은 ")
	sb.WriteString(agent.Name)
	if agent.Role != "" {
		sb.WriteString(" (역할: ")
		sb.WriteString(agent.Role)
		sb.WriteString(")")
	}
	if team.Name != "" {
		sb.WriteString(" 에이전트로, ")
		sb.WriteString(team.Name)
		sb.WriteString(" 팀에 소속되어 있습니다")
		if team.Mission != "" {
			sb.WriteString(".\n팀 미션: ")
			sb.WriteString(team.Mission)
		}
	}
	sb.WriteString(".\n\n")

	// Workflow context: show step progress and accumulated context from prior steps
	if task.WorkflowEnabled && len(task.WorkflowSteps) > 0 {
		sb.WriteString(fmt.Sprintf("## 워크플로 진행 상황\n현재 스텝: %d / %d", task.WorkflowStep+1, len(task.WorkflowSteps)))
		if task.WorkflowStep < len(task.WorkflowSteps) {
			sb.WriteString(" (")
			sb.WriteString(task.WorkflowSteps[task.WorkflowStep].Label)
			sb.WriteString(")")
		}
		sb.WriteString("\n")
		if task.AccContext != "" {
			sb.WriteString("\n## 이전 스텝 결과\n")
			sb.WriteString(task.AccContext)
			sb.WriteString("\n")
		}
	} else if task.AccContext != "" {
		// Non-workflow rerun: AccContext is where rejectReport appends each
		// "Boss 피드백" entry. Without this branch the feedback gets persisted
		// to the task row but never enters the prompt, so the LLM just
		// reruns the original brief and the user sees "same result again".
		sb.WriteString("## 이전 실행 피드백\n")
		sb.WriteString(fmt.Sprintf("아래는 %s가 이전 결과를 보고 남긴 피드백입니다. 이번 재실행에서는 반드시 이 피드백을 반영해 결과를 다르게 만드세요.\n\n", userLabel))
		sb.WriteString(task.AccContext)
		sb.WriteString("\n\n")
	}

	sb.WriteString("\n## 태스크\n")
	sb.WriteString(task.Title)
	sb.WriteString("\n")
	if task.Description != "" {
		sb.WriteString("\n## 상세 내용\n")
		sb.WriteString(task.Description)
		sb.WriteString("\n")
	}
	if attachmentBlock != "" {
		sb.WriteString(attachmentBlock)
	}

	// Stage 1-C RAG inject. Lives *below* the task brief because the user's
	// current instruction always wins (priority table: 시스템 > 사용자 메모리
	// > 태스크 지시 > RAG 참고 자료). Sources are surfaced inline so the
	// model is forced to cite — plan/rag-and-memory-roadmap.md "프롬프트 작성"
	// 레이어 참고.
	if len(ragHits) > 0 {
		sb.WriteString("\n## 참고 자료 (이 워크스페이스의 승인된 과거 작업)\n")
		sb.WriteString("아래는 워크스페이스 owner 가 \"지식베이스 등록\" 으로 승인한 과거 리포트/문서 발췌입니다. ")
		sb.WriteString("현재 태스크 지시와 충돌하면 현재 태스크 지시를 따르고, 인용 시 항목 헤더의 ID 를 그대로 표기하세요.\n\n")
		for _, h := range ragHits {
			sb.WriteString(fmt.Sprintf("- [%s #%s] %s\n", h.SourceType, h.SourceID, strings.TrimSpace(h.Title)))
			if h.Snippet != "" {
				sb.WriteString("  ")
				sb.WriteString(h.Snippet)
				sb.WriteString("\n")
			}
		}
		sb.WriteString("\n")
	}

	sb.WriteString("\n## [필수] 당신이 가진 능력의 한계\n")
	sb.WriteString("- **당신은 텍스트만 생성하는 분석/조언 에이전트입니다.** 검색 외에는 어떠한 도구도 갖지 않습니다.\n")
	sb.WriteString("- **수행 불가 동작**: 시스템 명령 실행(systemctl, restart, kill 등), SSH 접속, 파일 수정, API 호출, 서버/DB/네트워크 접근, 모니터링 도구 조회, 로그 직접 열람, 메시지 발송.\n")
	sb.WriteString("- **수행한 척 시나리오를 절대 만들지 마세요.** \"재시작했습니다\", \"확인했습니다\", \"조치를 완료했습니다\", \"로그를 분석한 결과\" 같은 가짜 실행 진술은 환각이며 보고서의 신뢰를 파괴합니다.\n")
	sb.WriteString("- 받은 정보(태스크 제목/상세, 이전 스텝 결과, 검색 결과)만으로 분석·계획·권고만 작성하세요.\n")

	sb.WriteString("\n## [필수] 정보 수집 원칙\n")
	sb.WriteString("- **검색을 적극 활용**: 날씨/뉴스/가격/영업시간/최신 정보 등 실시간성이 필요한 내용은 Google 검색 도구를 통해 직접 조회한 결과를 근거로 답변하세요.\n")
	sb.WriteString("- **허위 정보 절대 금지**: 검색해도 확인되지 않는 정보(매장명, 주소, 연락처, 가격 등)는 만들어내지 말고, 검색 결과의 출처를 따라 사실만 전하세요.\n")
	sb.WriteString("- **불확실한 정보는 명시**: 확인할 수 없거나 출처가 약한 내용은 추정임을 분명히 밝히세요. \"실시간 정보를 알 수 없다\"로 결론을 회피하지 말고, 가능한 한 검색으로 답을 찾아내세요.\n")

	// runbook(vault 문서)이 주입됐다면 그 절차/고유명사를 우선한다. 일반론·추정으로
	// 대체하면 안 됨 — 예: 엔진이 Avast인데 "ClamAV로 추정" 같은 환각 차단.
	if hasRunbookHit(ragHits) {
		sb.WriteString("\n## [필수] Runbook 우선\n")
		sb.WriteString("- 위 참고 자료에 이 알람 유형의 **runbook(대응 절차)** 이 포함되어 있습니다. 일반론이나 추정 대신 **runbook에 적힌 점검 명령·고유명사(엔진명·데몬명 등)·기준을 그대로 따르세요.**\n")
		sb.WriteString("- runbook이 특정 도구/엔진을 명시하면 다른 도구를 추정하지 마세요. runbook의 점검 명령을 \"권고 조치\"의 실행 명령으로 구체화하고, 각 명령이 어떤 실제 출력값을 확인하려는 것인지 명시하세요.\n")
		sb.WriteString("- runbook은 \"수집 → 분석 → 조치\" 순서를 전제합니다. 실제 수집값이 아직 없다면 분석을 단정하지 말고 \"수집 필요\"로 표기하세요.\n")
	}

	sb.WriteString("\n## 보고서 형식\n")
	sb.WriteString("아래 4개 섹션을 그대로 사용하세요. 빈 섹션은 \"해당 없음\"으로 표기.\n\n")
	sb.WriteString("### 분석\n받은 정보로부터 파악되는 사실 정리. 추측은 \"(추정)\" 표시. **실제 로그·시스템 상태값이 없으면 \"데이터 미수집\"으로 명시하고 추정으로 단정하지 말 것.**\n\n")
	sb.WriteString("### 권고 조치\n사람(운영자)이 직접 수행해야 할 명령/액션 목록. 가능하면 실행 명령을 코드 블록으로 제시. **이 명령들은 당신이 실행하는 것이 아님을 분명히 하세요.**\n\n")
	sb.WriteString("### 추가 확인 필요\n결정을 내리기 전에 운영자가 점검·조회해야 할 항목 (예: 특정 로그 파일, 모니터링 대시보드, 의존 시스템 상태).\n\n")
	sb.WriteString("### 한계 / 불확실성\n현재 정보만으로 단정할 수 없는 부분, 가정한 전제, 추가 데이터 필요한 영역.\n")

	return sb.String()
}
