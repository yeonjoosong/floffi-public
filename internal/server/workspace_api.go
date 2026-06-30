package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func (s *Server) handleWorkspace(w http.ResponseWriter, r *http.Request) {
	ctx := s.resolveActiveWorkspace(w, r)
	if ctx == nil {
		return
	}
	store := ctx.store
	canManageSecrets := canManageWorkspaceSecrets(ctx.member.Role, ctx.user.IsAdmin)

	switch r.Method {
	case http.MethodGet:
		state := store.snapshot()
		if !canManageSecrets {
			state = redactWorkspaceSecrets(state)
		}
		w.Header().Set("ETag", store.getETag())
		writeJSON(w, http.StatusOK, state)
	case http.MethodPut:
		// Optimistic concurrency: client must echo the ETag it last saw.
		// If someone else (or a webhook / agent) has changed state since,
		// reject so the client refetches and reapplies on top of fresh state.
		if ifMatch := strings.TrimSpace(r.Header.Get("If-Match")); ifMatch != "" {
			if current := store.getETag(); current != "" && ifMatch != current {
				w.Header().Set("ETag", current)
				writeJSON(w, http.StatusPreconditionFailed, map[string]any{
					"error":   "etag_mismatch",
					"current": current,
				})
				return
			}
		}

		var next workspaceState
		if err := json.NewDecoder(r.Body).Decode(&next); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "invalid_json",
			})
			return
		}

		// ?reset=true: 보드 명시적 초기화 — merge 스킵, 완전 치환
		// 일반 PUT: webhook 태스크/보고서/기록 로그 보존
		isReset := r.URL.Query().Get("reset") == "true"
		current := store.snapshot()
		if !canManageSecrets {
			next = preserveProtectedWorkspaceSecrets(next, current)
		}
		if err := validateNotificationTargets(next.Notifications); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "invalid_notification_target",
			})
			return
		}
		if !isReset {
			next.Tasks = mergeTasksServerSide(current.Tasks, next.Tasks)
			next.BossReports = mergeBossReportsServerSide(current.BossReports, next.BossReports)
			next.Sessions = mergeSessionsServerSide(current.Sessions, next.Sessions)
		}

		// replace() does the dirty check internally — no-op when state
		// hashes identical, so this PUT becomes essentially free.
		if err := store.replace(next); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error": "workspace_save_failed",
			})
			return
		}

		w.Header().Set("ETag", store.getETag())
		saved := store.snapshot()
		if !canManageSecrets {
			saved = redactWorkspaceSecrets(saved)
		}
		writeJSON(w, http.StatusOK, saved)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleTaskDispatch routes /api/tasks/{id}/run, /reset, and /attachments[/{id}].
func (s *Server) handleTaskDispatch(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/run"):
		s.handleTaskRun(w, r)
	case strings.HasSuffix(r.URL.Path, "/reset"):
		s.handleTaskReset(w, r)
	case strings.Contains(r.URL.Path, "/attachments"):
		s.handleTaskAttachments(w, r)
	default:
		http.NotFound(w, r)
	}
}

// handleTaskReset handles POST /api/tasks/{id}/reset
// Resets a stuck active task back to queued and releases the assigned agent.
func (s *Server) handleTaskReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	wsCtx := s.resolveActiveWorkspace(w, r)
	if wsCtx == nil {
		return
	}
	store := wsCtx.store

	taskID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/tasks/"), "/reset")
	if taskID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid task path"})
		return
	}

	state := store.snapshot()
	var agentID string
	for _, t := range state.Tasks {
		if t.ID == taskID {
			agentID = t.AgentID
			break
		}
	}

	if err := store.setTaskExecution(taskID, "queued", ""); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}

	// Release agent if assigned
	if agentID != "" {
		updated := store.snapshot()
		for i, m := range updated.TeamMembers {
			if m.ID == agentID {
				updated.TeamMembers[i].Status = "idle"
				break
			}
		}
		_ = store.replace(updated)
	}

	writeJSON(w, http.StatusOK, store.snapshot())
}

// handleTaskRun handles POST /api/tasks/{id}/run
// It sets the task to active, calls the LLM agent, then marks it completed.
func (s *Server) handleTaskRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	wsCtx := s.resolveActiveWorkspace(w, r)
	if wsCtx == nil {
		return
	}
	store := wsCtx.store

	// Extract task ID: /api/tasks/{id}/run
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	taskID := strings.TrimSuffix(trimmed, "/run")
	if taskID == "" || taskID == trimmed {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid task path"})
		return
	}

	state := store.snapshot()

	// Find task
	var task workspaceTask
	found := false
	for _, t := range state.Tasks {
		if t.ID == taskID {
			task = t
			found = true
			break
		}
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "task not found"})
		return
	}

	// Find agent
	var agent workspaceAgent
	for _, a := range state.TeamMembers {
		if a.ID == task.AgentID {
			agent = a
			break
		}
	}

	// Find team
	var team workspaceTeam
	for _, t := range state.Teams {
		if t.ID == task.TeamID {
			team = t
			break
		}
	}

	// Find first enabled provider
	var provider workspaceProvider
	for _, p := range state.Providers {
		if p.Enabled {
			provider = p
			break
		}
	}

	// Mark task active
	if err := store.setTaskExecution(taskID, "active", agent.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to activate task"})
		return
	}

	var reportText string
	var err error
	reportText, err = runAgentTask(r.Context(), task, agent, team, provider, s.limiter, s.quota, store, s.authStore)
	if err != nil {
		// Revert to queued on failure
		_ = store.setTaskExecution(taskID, "queued", "")
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	// Complete task + create boss report
	updated, err := store.completeTaskWithReport(taskID, agent, team, reportText)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to complete task"})
		return
	}

	// Surface the post-run ETag on the response so the client can update its
	// lastETag without an extra GET. Without this, the next debounced PUT
	// uses a stale If-Match and gets 412'd, forcing a wasted re-fetch.
	w.Header().Set("ETag", store.getETag())
	writeJSON(w, http.StatusOK, updated)
}

// handleWorkspaceStream — Server-Sent Events stream that pushes "change"
// events with the new ETag whenever the workspace state mutates. Clients
// can subscribe instead of polling: on each event they refetch /api/workspace.
//
// Initial event "ready" carries the current ETag so the client can decide
// whether it already has the latest state. A heartbeat comment is sent every
// 30 s to defeat idle-timeout proxies.
func (s *Server) handleWorkspaceStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	wsCtx := s.resolveActiveWorkspace(w, r)
	if wsCtx == nil {
		return
	}
	store := wsCtx.store

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering if proxied
	w.WriteHeader(http.StatusOK)

	ch := s.subscribeSSE(wsCtx.user.ID)
	defer s.unsubscribeSSE(ch)

	// Initial sync: tell the client the current ETag so it can compare and
	// fetch only if its local copy is stale.
	fmt.Fprintf(w, "event: ready\ndata: %s\n\n", store.getETag())
	flusher.Flush()

	// 30s heartbeat — re-authentication fallback. Primary revoke path
	// is the push from notifyUserSessionRevoked (0s latency), so we
	// don't need to poll quickly here; this just catches any session
	// that got revoked while the push couldn't reach the channel
	// (buffer full, race conditions, etc.).
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg, open := <-ch:
			if !open {
				return
			}
			// The auth handler's OnSessionRevoked callback pushes the
			// revoke sentinel onto our channel; translate it into a
			// session-revoked SSE event and close.
			if msg == sseRevokeMarker {
				fmt.Fprintf(w, "event: session-revoked\ndata: revoked\n\n")
				flusher.Flush()
				return
			}
			fmt.Fprintf(w, "event: change\ndata: %s\n\n", msg)
			flusher.Flush()
		case <-heartbeat.C:
			// Heartbeat fallback — re-check auth in case the push path
			// dropped a notification. Primary delivery is the
			// sseRevokeMarker case above; this just keeps the "kicked
			// from another device" detection bounded if anything goes
			// wrong with the push.
			if !s.authed(r) {
				fmt.Fprintf(w, "event: session-revoked\ndata: revoked\n\n")
				flusher.Flush()
				return
			}
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) handleVaultSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	wsCtx := s.resolveActiveWorkspace(w, r)
	if wsCtx == nil {
		return
	}

	results := wsCtx.store.searchVault(r.URL.Query().Get("q"))
	writeJSON(w, http.StatusOK, map[string]any{
		"results": results,
	})
}
