package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// handlePlayground is a one-shot LLM test endpoint: caller picks provider +
// model + prompt and gets back the raw response and latency. It bypasses the
// workspace state so each test is independent and side-effect-free, but it
// still respects the daily call cap and RPM limiter so playground use cannot
// silently burn quota or money.
//
// Auth: floffi session required. Key resolution: BYOK (X-LLM-Key header)
// preferred, env-var fallback otherwise — same plumbing as runAgentTask.
func (s *Server) handlePlayground(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authed(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}

	var req struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Prompt   string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "prompt is required"})
		return
	}

	used, limit, ok := s.quota.tryConsume()
	if !ok {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": fmt.Sprintf("일일 호출 한도에 도달했습니다 (%d/%d)", used, limit),
		})
		return
	}
	logger.Info("[playground] call", "provider", req.Provider, "model", req.Model, "quotaUsed", used, "quotaLimit", limit)

	if err := s.limiter.Wait(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": err.Error()})
		return
	}

	started := time.Now()
	var (
		text string
		err  error
	)
	switch strings.ToLower(req.Provider) {
	case "anthropic":
		text, err = callAnthropic(r.Context(), req.Prompt, resolveModel(req.Model, "claude-sonnet-4-5-20251001"))
	case "openai":
		text, err = callOpenAI(r.Context(), req.Prompt, resolveModel(req.Model, "o4-mini"))
	case "gemini":
		text, err = callGemini(r.Context(), req.Prompt, resolveModel(req.Model, "gemini-2.5-flash"), nil)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown provider"})
		return
	}
	latencyMs := time.Since(started).Milliseconds()

	if err != nil {
		logger.Error("[playground] FAILED", "latencyMs", latencyMs, "err", err)
		writeJSON(w, http.StatusOK, map[string]any{
			"error":     err.Error(),
			"latencyMs": latencyMs,
		})
		return
	}
	logger.Info("[playground] OK", "latencyMs", latencyMs, "replyBytes", len(text))
	writeJSON(w, http.StatusOK, map[string]any{
		"text":      text,
		"latencyMs": latencyMs,
	})
}
