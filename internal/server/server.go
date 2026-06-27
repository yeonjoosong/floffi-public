package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"floffi/internal/server/auth"
)

type Server struct {
	httpServer  *http.Server
	auth        AuthConfig
	authStore   *auth.Store   // SQLite-backed user/session store (Phase 1/2)
	authHandler *auth.Handler // /api/auth/* routes
	// workspaces is the Phase 11 lazy cache: workspaceID -> *workspaceStore.
	// Per-workspace handlers resolve a store via workspaces.For(ctx, id).
	workspaces *workspaceRegistry
	// workspace is the in-memory store for the default workspace
	// (super admin's row). Transitional during the Phase 11 rollout —
	// pre-existing call sites that don't yet carry a workspaceID read
	// from this single store, so the codebase stays compilable while
	// each handler is migrated to look up by user. Pre-Phase-11 this
	// was the only workspace store; post-Phase-11 it shrinks to "the
	// default tenant for legacy paths".
	workspace          *workspaceStore
	defaultWorkspaceID string
	limiter            *llmRateLimiter // shared RPM cap across all LLM calls
	quota              *dailyQuota     // shared daily-total cap (cost ceiling)
	sseMu              sync.RWMutex
	sseSubs            map[chan string]string // SSE subscribers — key = ETag publish channel, value = userID for revoke-targeting (empty = unauth)
}

func New(addr string, ac AuthConfig) *Server {
	if err := validateDeploymentSecurity(addr); err != nil {
		panic(err)
	}
	if _, err := os.Getwd(); err != nil {
		panic(err)
	}
	if err := ensureDataDir(); err != nil {
		panic(err)
	}

	authStore, err := auth.Open(".data/auth.db")
	if err != nil {
		panic(fmt.Errorf("auth store open: %w", err))
	}
	authHandler := auth.NewHandler(authStore)
	if err := ensureBootstrapAdminIntegrity(authStore); err != nil {
		panic(err)
	}

	registry, workspace, defaultID, err := bootstrapWorkspaces(authStore)
	if err != nil {
		panic(err)
	}

	s := &Server{
		httpServer: &http.Server{
			Addr:              addr,
			ReadHeaderTimeout: 5 * time.Second,
		},
		auth:               ac.withDefaults(),
		authStore:          authStore,
		authHandler:        authHandler,
		workspaces:         registry,
		workspace:          workspace,
		defaultWorkspaceID: defaultID,
		limiter:            newLLMRateLimiter(),
		quota:              newDailyQuota(),
		sseSubs:            map[chan string]string{},
	}

	// Wire registry-level changes -> SSE. The registry sets the onChange
	// callback on every newly-loaded store, so workspaces beyond the
	// default also broadcast as they're touched.
	registry.onChange = s.publishWorkspaceChanged
	if workspace != nil {
		workspace.onChange = s.publishWorkspaceChanged
	}
	// Wire single_session revoke -> SSE so the kicked browser is pushed a
	// session-revoked event the instant the new login completes.
	authHandler.OnSessionRevoked = s.notifyUserSessionRevoked
	// Wire signup -> default workspace bootstrap so every new account has
	// a non-empty switcher the first time they hit the workspace API.
	authHandler.OnUserSignedUp = s.provisionDefaultWorkspaceForUser

	s.httpServer.Handler = s.newHandler()
	return s
}

const sseRevokeMarker = "__session_revoked__"

func validateDeploymentSecurity(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.TrimSpace(host)
	if os.Getenv("FLOFFI_PROD") == "1" {
		if strings.TrimSpace(os.Getenv("FLOFFI_JWT_SECRET")) == "" {
			return errors.New("FLOFFI_PROD=1 requires FLOFFI_JWT_SECRET")
		}
		if os.Getenv("FLOFFI_ALLOW_INSECURE_HTTP") == "1" {
			return errors.New("FLOFFI_PROD=1 cannot be combined with FLOFFI_ALLOW_INSECURE_HTTP=1")
		}
		return nil
	}
	if os.Getenv("FLOFFI_ALLOW_DEV_BIND") == "1" {
		return nil
	}
	if isPublicBindHost(host) {
		return fmt.Errorf("refusing non-production bind on %q; set FLOFFI_PROD=1 or FLOFFI_ALLOW_DEV_BIND=1", host)
	}
	return nil
}

func isPublicBindHost(host string) bool {
	host = strings.TrimSpace(strings.Trim(host, "[]"))
	switch strings.ToLower(host) {
	case "", "localhost", "127.0.0.1", "::1":
		return false
	case "0.0.0.0", "::":
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return !ip.IsLoopback()
	}
	return true
}

// publishWorkspaceChanged fans out a new ETag to every connected SSE client.
// Slow subscribers (full buffered channel) are skipped so one stuck client
// can't block other notifications.
func (s *Server) publishWorkspaceChanged(etag string) {
	s.sseMu.RLock()
	defer s.sseMu.RUnlock()
	for ch := range s.sseSubs {
		select {
		case ch <- etag:
		default:
			// drop if subscriber's buffer is full — they'll catch up on next event
		}
	}
}

// notifyUserSessionRevoked finds every SSE subscriber tagged with the
// given userID and pushes the revoke sentinel onto its channel. Called
// from the auth handler via the OnSessionRevoked callback right after
// RevokeAllUserSessions runs, so the kicked browser sees the event in
// the same tick as the new login completes (0s latency vs. the
// heartbeat fallback's ~30s).
func (s *Server) notifyUserSessionRevoked(userID string) {
	if userID == "" {
		return
	}
	s.sseMu.RLock()
	defer s.sseMu.RUnlock()
	for ch, uid := range s.sseSubs {
		if uid != userID {
			continue
		}
		select {
		case ch <- sseRevokeMarker:
		default:
			// drop if buffer full — heartbeat will catch it on the next tick
		}
	}
}

// subscribeSSE registers a new SSE channel and tags it with the
// userID that owns the connection (empty string for unauthenticated
// streams — those won't receive revoke pushes, since there's no
// session to revoke).
func (s *Server) subscribeSSE(userID string) chan string {
	// Buffer of 16 — enough headroom for a quick burst of workspace
	// ETag updates + a revoke sentinel without the push path landing
	// in the "default: drop" branch.
	ch := make(chan string, 16)
	s.sseMu.Lock()
	s.sseSubs[ch] = userID
	s.sseMu.Unlock()
	return ch
}

func (s *Server) unsubscribeSSE(ch chan string) {
	s.sseMu.Lock()
	delete(s.sseSubs, ch)
	s.sseMu.Unlock()
	close(ch)
}

// autoRetryThreshold returns the configured stuck-task timeout.
// Override with AUTO_RETRY_THRESHOLD_SECS env var (default: 150 s).
func autoRetryThreshold() time.Duration {
	if v := os.Getenv("AUTO_RETRY_THRESHOLD_SECS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return 150 * time.Second
}

// Scan intervals for the two background workers.
// The main scanner checks "active" tasks every 30 s.
// The fast watchdog checks orphaned "retrying" tasks every 5 s.
const (
	stuckTaskScanInterval    = 30 * time.Second
	retryingWatchdogInterval = 5 * time.Second
	// A "retrying" task is considered orphaned if its goroutine hasn't
	// transitioned it to "active" within this window.
	retryingOrphanThreshold = 15 * time.Second
)

func (s *Server) ListenAndServe(ctx context.Context) error {
	threshold := autoRetryThreshold()
	fmt.Println("─────────────────────────────────────────────────────")
	fmt.Printf(" floffi server listening on %s\n", s.httpServer.Addr)
	fmt.Printf(" auto-retry threshold: %s  watchdog: every %s (orphan window: %s)\n",
		threshold, retryingWatchdogInterval, retryingOrphanThreshold)
	fmt.Printf(" guards: max-auto-retries=%d  daily-call-cap=%d\n",
		maxAutoRetries(), s.quota.limit)
	if os.Getenv("FLOFFI_PROD") != "1" {
		fmt.Println(" auth: DEV mode — ephemeral JWT key unless FLOFFI_JWT_SECRET is set; non-local requests still receive Secure cookies")
	}
	fmt.Println("─────────────────────────────────────────────────────")

	// Worker 1 — main scanner: detects "active" tasks stuck beyond threshold.
	go func() {
		ticker := time.NewTicker(stuckTaskScanInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.retryStuckTasks(ctx, threshold)
			case <-ctx.Done():
				return
			}
		}
	}()

	// Worker 2 — fast watchdog: detects orphaned "retrying" tasks.
	// These arise when the rerunTask goroutine panics or exits without
	// transitioning the task to "active" / "queued".
	go func() {
		ticker := time.NewTicker(retryingWatchdogInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.recoverOrphanedRetrying(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()

	// Worker 3 — auth rate-limiter GC. Allow() already prunes its own
	// key, so this is purely a memory bound against a long tail of
	// one-shot IPs piling up in the map.
	if s.authHandler != nil {
		go s.authHandler.StartRateLimitGC(ctx)
	}

	errCh := make(chan error, 1)

	go func() {
		err := s.httpServer.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := s.httpServer.Shutdown(shutdownCtx); err != nil {
			return err
		}

		return <-errCh
	}
}

// retryStuckTasks marks stuck "active" tasks as "retrying" and
// immediately spawns a rerunTask goroutine for each one. Phase 11
// iterates every workspace currently in the registry cache — that's
// "every tenant a user touched since boot." Workspaces never opened
// won't have active tasks, so missing them costs nothing.
func (s *Server) retryStuckTasks(ctx context.Context, threshold time.Duration) {
	for _, entry := range s.workspaces.CachedStores() {
		stuck := entry.Store.markStuckTasksRetrying(threshold)
		for _, task := range stuck {
			taskID := task.ID
			logger.Info("auto-retry: task active past threshold, retrying", "task", taskID, "workspace", entry.ID, "threshold", threshold.String())
			go s.rerunTask(ctx, entry.ID, taskID)
		}
	}
}

// recoverOrphanedRetrying rescues tasks that have been stuck in
// "retrying" beyond retryingOrphanThreshold — their goroutine likely
// panicked or was cancelled before it could transition them to
// "active". Mirrors retryStuckTasks: iterate every cached workspace
// and reset+respawn per tenant.
func (s *Server) recoverOrphanedRetrying(ctx context.Context) {
	for _, entry := range s.workspaces.CachedStores() {
		orphaned := entry.Store.recoverOrphanedRetrying(retryingOrphanThreshold)
		for _, task := range orphaned {
			taskID := task.ID
			logger.Warn("retrying-watchdog: orphaned task, re-spawning", "task", taskID, "workspace", entry.ID)
			go s.rerunTask(ctx, entry.ID, taskID)
		}
	}
}

// rerunTask re-executes a task: active → LLM call → completed.
// On any failure the task is reset to "queued" for manual retry.
// A deferred recover ensures a panicking goroutine never leaves the task
// permanently stuck in "retrying" or "active".
//
// Workflow tasks (AutoRun=true, e.g. tasks spawned by the webhook ingest
// path for critical alarms) require the full multi-step pipeline, so we
// delegate to runWebhookWorkflow instead of running a single LLM call.
// Without this delegation a webhook task that fails mid-pipeline gets
// stuck in the wf-planning column forever: rerunTask used to fire one
// LLM call and call completeTaskWithReport, which doesn't move the task
// to Done (it's not the last step) and doesn't advance to the next step
// either — so the kanban card sits orphaned.
func (s *Server) rerunTask(ctx context.Context, workspaceID, taskID string) {
	store, err := s.workspaces.For(ctx, workspaceID)
	if err != nil {
		logger.Warn("rerunTask: workspace no longer available", "workspace", workspaceID, "err", err)
		return
	}
	defer func() {
		if r := recover(); r != nil {
			logger.Error("rerunTask panic — resetting to queued", "task", taskID, "workspace", workspaceID, "panic", r)
			_ = store.setTaskExecution(taskID, "queued", "")
		}
	}()

	state := store.snapshot()

	var task workspaceTask
	for _, t := range state.Tasks {
		if t.ID == taskID {
			task = t
			break
		}
	}
	if task.ID == "" {
		return
	}

	// Workflow tasks: delegate to the full pipeline runner. It picks up
	// from the current WorkflowStep, so a task that failed at step 2/5
	// resumes from step 2/5 (not from scratch) and runs through the
	// remaining steps, finally moving to Done and firing notifications.
	if task.WorkflowEnabled && len(task.WorkflowSteps) > 0 {
		s.runWebhookWorkflow(workspaceID, taskID)
		return
	}

	var agent workspaceAgent
	for _, a := range state.TeamMembers {
		if a.ID == task.AgentID {
			agent = a
			break
		}
	}

	var team workspaceTeam
	for _, t := range state.Teams {
		if t.ID == task.TeamID {
			team = t
			break
		}
	}

	var provider workspaceProvider
	for _, p := range state.Providers {
		if p.Enabled {
			provider = p
			break
		}
	}

	if err := store.setTaskExecution(taskID, "active", agent.ID); err != nil {
		_ = store.setTaskExecution(taskID, "queued", "")
		logger.Error("rerunTask: failed to activate task", "task", taskID, "err", err)
		return
	}

	reportText, err := runAgentTask(ctx, task, agent, team, provider, s.limiter, s.quota, store, s.authStore)
	if err != nil {
		_ = store.setTaskExecution(taskID, "queued", "")
		logger.Error("rerunTask: task failed", "task", taskID, "err", err)
		return
	}

	if _, err := store.completeTaskWithReport(taskID, agent, team, reportText); err != nil {
		logger.Error("rerunTask: report save failed", "task", taskID, "err", err)
	}
}
