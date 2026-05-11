package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// webhookIngestBody is a union of the two payload shapes the ingest
// endpoint accepts:
//
//  1. Native floffi format — {source, data, hasNewData}. hasNewData=false
//     short-circuits with 200 so a polling cron can call every minute
//     cheaply and only pay the workflow cost when something actually changed.
//
//  2. Alarming generic format — {id, title, message, level, source,
//     created_at}. Sent by https://github.com/yeonjoosong/alarming when its
//     outbound webhook fires (or any service using the same shape).
//     level routes the alarm: error/critical kicks off the 5-step
//     workflow as before; info/warning just drops a report into the
//     inbox so they don't burn LLM budget on low-severity noise.
//
// Both shapes are decoded into the same struct; the handler picks the
// relevant fields by checking which ones were populated.
type webhookIngestBody struct {
	// Native fields
	Source     string `json:"source"`
	Data       string `json:"data"`
	HasNewData bool   `json:"hasNewData"`

	// Alarming-compatible fields
	Title     string `json:"title"`
	Message   string `json:"message"`
	Level     string `json:"level"`
	CreatedAt string `json:"created_at"`
	// ID is accepted but currently unused — captured so json.Decode
	// doesn't error on unknown fields and so we can echo it back in
	// future versions if dedup is needed.
	AlarmID json.Number `json:"id,omitempty"`
}

// handleWebhookIngest handles POST /api/webhooks/{token}/ingest
// Called by a remote cron job (or alarming outbound webhook) when new
// data is available. Response codes:
//
//	200 {"status":"skipped"}                 — native body with hasNewData=false
//	200 {"status":"duplicate","deliveryId":.} — X-Delivery-Id already accepted (idempotent retry)
//	200 {"status":"notified","reportId":...} — alarming info/warning routed to inbox
//	202 {"status":"accepted","taskId":...}   — workflow started (native data, or alarming error/critical)
//	400 / 401                                 — invalid path / token / json
func (s *Server) handleWebhookIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract token: /api/webhooks/{token}/ingest
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/webhooks/")
	token := strings.TrimSuffix(trimmed, "/ingest")
	if token == "" || token == trimmed {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid webhook path"})
		return
	}

	// Phase 11: tokens index into the workspaces table — the row whose
	// webhook_token matches identifies which tenant's board the event
	// belongs to. Resolving via the DB instead of comparing against a
	// single cached workspace lets each user run their own webhook
	// pipeline without the events leaking into someone else's board.
	wsRow, err := s.authStore.FindWorkspaceByWebhookToken(r.Context(), token)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid or disabled token"})
		return
	}
	store, err := s.workspaces.For(r.Context(), wsRow.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "workspace_open_failed"})
		return
	}
	state := store.snapshot()
	if !state.WebhookConfig.Enabled || state.WebhookConfig.Token == "" || token != state.WebhookConfig.Token {
		// Token matched the row but the row has the webhook disabled.
		// Same error envelope as the "no such token" branch so an
		// attacker can't distinguish "token wrong" from "token right
		// but disabled".
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid or disabled token"})
		return
	}

	// Idempotency gate: alarming's durable outbox delivers at-least-once and
	// stamps every attempt of one logical delivery with the same
	// X-Delivery-Id (UUID). Record-before-process: a retry of an
	// already-accepted delivery returns 200 here so the sender marks it
	// delivered and stops — without spawning a second workflow. Requests
	// without the header (manual curl, other senders) skip the gate.
	if deliveryID := strings.TrimSpace(r.Header.Get("X-Delivery-Id")); deliveryID != "" {
		first, err := s.authStore.MarkWebhookDeliverySeen(r.Context(), wsRow.ID, deliveryID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "dedup check failed"})
			return
		}
		if !first {
			writeJSON(w, http.StatusOK, map[string]any{"status": "duplicate", "deliveryId": deliveryID})
			return
		}
	}

	var body webhookIngestBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}

	// Detect alarming-shaped payload: presence of title or message implies
	// the outbound webhook from alarming (or compatible service). Native
	// floffi polling cron has neither — it uses {source, data, hasNewData}.
	isAlarming := strings.TrimSpace(body.Title) != "" || strings.TrimSpace(body.Message) != ""

	if isAlarming {
		s.ingestAlarmingPayload(w, store, wsRow.ID, body)
		return
	}

	// Native path: skip when there's nothing new.
	if !body.HasNewData {
		writeJSON(w, http.StatusOK, map[string]any{"status": "skipped"})
		return
	}

	source := strings.TrimSpace(body.Source)
	if source == "" {
		source = "webhook"
	}

	// Build workflow steps using fixed workflow agent/section IDs
	defaultSteps := []workspaceWorkflowStep{
		{AgentID: "planner",    SectionID: "wf-planning",  Label: "Plan"},
		{AgentID: "builder",    SectionID: "wf-building",  Label: "Build"},
		{AgentID: "executor",   SectionID: "wf-executing", Label: "Execute"},
		{AgentID: "analyst",    SectionID: "wf-analysis",  Label: "Analyze"},
		{AgentID: "summarizer", SectionID: "wf-review",    Label: "Summarize"},
	}

	firstStep := defaultSteps[0]
	assigneeName := ""
	for _, m := range state.TeamMembers {
		if m.ID == firstStep.AgentID {
			assigneeName = m.Name
			break
		}
	}
	defaultTeamID := ""
	if len(state.Teams) > 0 {
		defaultTeamID = state.Teams[0].ID
	}

	now := time.Now().UTC()
	taskID := fmt.Sprintf("webhook-%d", now.UnixMilli())
	task := workspaceTask{
		ID:              taskID,
		Title:           fmt.Sprintf("[%s] %s", source, now.In(time.FixedZone("KST", 9*60*60)).Format("01/02 15:04")),
		Description:     body.Data,
		Assignee:        assigneeName,
		Status:          firstStep.SectionID,
		CreatedAt:       now.Format(time.RFC3339),
		Date:            now.In(time.FixedZone("KST", 9*60*60)).Format("2006-01-02"),
		TeamID:          defaultTeamID,
		AgentID:         firstStep.AgentID,
		Execution:       "queued",
		WorkflowEnabled: true,
		WorkflowStep:    0,
		WorkflowSteps:   defaultSteps,
		AutoRun:         true,
	}

	if err := store.addTask(task); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to create task"})
		return
	}

	_ = store.addSessionLog(workspaceSessionLog{
		ID:        fmt.Sprintf("item-%d-wh", now.UnixMilli()),
		Title:     "Webhook 수신",
		UpdatedAt: now.Format(time.RFC3339),
		Summary:   fmt.Sprintf("'%s'에서 신규 데이터 수신. 워크플로 자동 시작.", source),
	})

	// Run the full workflow asynchronously — returns 202 immediately.
	// workspaceID is captured so the worker resolves the right store
	// on every step (the store map is keyed by ID, never by pointer).
	go s.runWebhookWorkflow(wsRow.ID, taskID)

	writeJSON(w, http.StatusAccepted, map[string]any{"status": "accepted", "taskId": taskID})
}

// runWebhookWorkflow runs all workflow steps sequentially in a goroutine.
// Intermediate steps are advanced without creating a boss report.
// The final step creates a boss report and fires notifications.
//
// workspaceID identifies which tenant this workflow belongs to — every
// store lookup goes through the registry so the worker survives a
// transient cache eviction and so the right state_json row is updated.
// webhookWorkflowTimeout bounds one full webhook-triggered workflow. A hung
// LLM call (provider stall) would otherwise pin the goroutine forever and
// block graceful shutdown. On timeout runAgentTask returns an error and the
// task is re-queued (see below), so the cap degrades gracefully rather than
// dropping work. Generous on purpose: multi-step workflows with rate-limit
// gaps can legitimately run several minutes.
const webhookWorkflowTimeout = 15 * time.Minute

func (s *Server) runWebhookWorkflow(workspaceID, taskID string) {
	ctx, cancel := context.WithTimeout(context.Background(), webhookWorkflowTimeout)
	defer cancel()
	store, err := s.workspaces.For(ctx, workspaceID)
	if err != nil {
		return // workspace was deleted while the task was queued
	}

	// AI 에이전트 OFF(agentMode="mcp") — LLM 5단계 파이프라인 대신 runbook의
	// [MCP] 단계를 결정론적으로 실행하는 단일 패스로 처리한다.
	if store.snapshot().Settings.AgentMode == "mcp" {
		s.runMCPWebhookWorkflow(ctx, store, taskID)
		return
	}

	for {
		state := store.snapshot()

		var task workspaceTask
		for _, t := range state.Tasks {
			if t.ID == taskID {
				task = t
				break
			}
		}
		if task.ID == "" {
			return // task was deleted
		}

		// Resolve agent, team, provider from current state
		var agent workspaceAgent
		var team workspaceTeam
		var provider workspaceProvider
		for _, a := range state.TeamMembers {
			if a.ID == task.AgentID {
				agent = a
				break
			}
		}
		for _, t := range state.Teams {
			if t.ID == task.TeamID {
				team = t
				break
			}
		}
		for _, p := range state.Providers {
			if p.Enabled {
				provider = p
				break
			}
		}

		stepNum := task.WorkflowStep + 1
		totalSteps := len(task.WorkflowSteps)
		stepLabel := ""
		if task.WorkflowStep < len(task.WorkflowSteps) {
			stepLabel = task.WorkflowSteps[task.WorkflowStep].Label
		}

		// 단계 시작 로그
		_ = store.addSessionLog(workspaceSessionLog{
			ID:        fmt.Sprintf("item-%d-wh-step%d-start", time.Now().UnixMilli(), stepNum),
			Title:     fmt.Sprintf("워크플로 %d/%d 시작 (%s)", stepNum, totalSteps, stepLabel),
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Summary:   fmt.Sprintf("'%s' — %s(%s) 처리 중...", task.Title, agent.Name, stepLabel),
		})

		if err := store.setTaskExecution(taskID, "active", agent.ID); err != nil {
			return
		}

		reportText, err := runAgentTask(ctx, task, agent, team, provider, s.limiter, s.quota, store, s.authStore)
		if err != nil {
			_ = store.setTaskExecution(taskID, "queued", "")
			_ = store.addSessionLog(workspaceSessionLog{
				ID:        fmt.Sprintf("item-%d-wh-err", time.Now().UnixMilli()),
				Title:     fmt.Sprintf("워크플로 오류 (%d/%d %s)", stepNum, totalSteps, stepLabel),
				UpdatedAt: time.Now().UTC().Format(time.RFC3339),
				Summary:   fmt.Sprintf("'%s': %s", task.Title, err.Error()),
			})
			return
		}

		isLastStep := task.WorkflowStep >= len(task.WorkflowSteps)-1

		if isLastStep {
			// 최종 단계: 보스 보고서 생성 + Done 이동 + 알림 발송
			_ = store.addSessionLog(workspaceSessionLog{
				ID:        fmt.Sprintf("item-%d-wh-done", time.Now().UnixMilli()),
				Title:     fmt.Sprintf("워크플로 완료 (%d/%d)", stepNum, totalSteps),
				UpdatedAt: time.Now().UTC().Format(time.RFC3339),
				Summary:   fmt.Sprintf("'%s' 전 단계 완료. 보고서 생성 및 알림 발송 중.", task.Title),
			})
			updated, err := store.completeTaskWithReport(taskID, agent, team, reportText)
			if err != nil {
				return
			}
			s.sendNotifications(updated, taskID, reportText)
			return
		}

		// 중간 단계: 다음 단계로 이동
		_ = store.addSessionLog(workspaceSessionLog{
			ID:        fmt.Sprintf("item-%d-wh-step%d-done", time.Now().UnixMilli(), stepNum),
			Title:     fmt.Sprintf("워크플로 %d/%d 완료 (%s)", stepNum, totalSteps, stepLabel),
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Summary:   fmt.Sprintf("'%s' — %s 단계 완료. 다음 단계로 이동.", task.Title, stepLabel),
		})
		if err := store.advanceWorkflowStep(taskID, task.WorkflowStep+1, reportText); err != nil {
			return
		}
	}
}

// notifyClient is shared across all notification POSTs so connections are
// reused instead of leaking a fresh transport per call. The 15s timeout
// caps a slow/stuck target.
var notifyClient = &http.Client{Timeout: 15 * time.Second}

// notifySem bounds how many notification HTTP calls run concurrently across
// the whole process. Without it, a workspace with many targets (or many
// workflows finishing at once) could fan out an unbounded number of
// in-flight requests. A slot is held only for the duration of one POST.
var notifySem = make(chan struct{}, 16)

// sendNotifications POSTs the final workflow summary to all enabled notification targets.
func (s *Server) sendNotifications(state workspaceState, taskID, summary string) {
	var taskTitle string
	for _, t := range state.Tasks {
		if t.ID == taskID {
			taskTitle = t.Title
			break
		}
	}

	payload, _ := json.Marshal(map[string]any{
		"event":   "workflow_completed",
		"taskId":  taskID,
		"task":    taskTitle,
		"summary": summary,
		"time":    time.Now().UTC().Format(time.RFC3339),
	})

	for _, n := range state.Notifications {
		if !n.Enabled {
			continue
		}
		go func(target workspaceNotificationTarget) {
			notifySem <- struct{}{}        // 동시 발송 수 제한 (슬롯 획득)
			defer func() { <-notifySem }() // 슬롯 반납
			req, err := http.NewRequest(http.MethodPost, target.URL, bytes.NewReader(payload))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := notifyClient.Do(req)
			if err != nil {
				return
			}
			resp.Body.Close()
		}(n)
	}
}

// ingestAlarmingPayload routes an alarming-style payload by level:
//
//	error / critical → kick off the full 5-step workflow (same path as
//	                   the native hasNewData=true branch). High-severity
//	                   alarms are the ones worth burning LLM budget on
//	                   for a structured plan/build/execute/analyze/review.
//	info / warning   → just append a boss report to the inbox so the
//	                   user sees the notification without spawning a task.
//	                   No LLM call, no kanban movement.
//
// The split point and the level vocabulary mirror alarming's schema
// (info / warning / error / critical); unknown levels are treated as
// low-severity to stay on the safe/cheap side.
func (s *Server) ingestAlarmingPayload(w http.ResponseWriter, store *workspaceStore, workspaceID string, body webhookIngestBody) {
	level := strings.ToLower(strings.TrimSpace(body.Level))
	source := strings.TrimSpace(body.Source)
	if source == "" {
		source = "alarm"
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		title = source
	}
	summary := strings.TrimSpace(body.Message)
	if summary == "" {
		summary = title
	}

	highSeverity := level == "error" || level == "critical"

	if !highSeverity {
		// Inbox-only: drop a boss report and return.
		levelTag := strings.ToUpper(level)
		if levelTag == "" {
			levelTag = "INFO"
		}
		reportTitle := fmt.Sprintf("[%s] %s · %s", levelTag, source, title)
		state, err := store.addBossReportOnly(reportTitle, summary)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to create report"})
			return
		}
		reportID := ""
		if len(state.BossReports) > 0 {
			reportID = state.BossReports[0].ID
		}
		_ = store.addSessionLog(workspaceSessionLog{
			ID:        fmt.Sprintf("item-%d-wh-notice", time.Now().UnixMilli()),
			Title:     fmt.Sprintf("알람 수신 (%s)", levelTag),
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Summary:   fmt.Sprintf("'%s'에서 %s 알람 수신. 워크플로 건너뜀, 인박스에만 표시.", source, levelTag),
		})
		writeJSON(w, http.StatusOK, map[string]any{"status": "notified", "reportId": reportID})
		return
	}

	// High severity → workflow. Reuse the same task-shape the native
	// path produces so runWebhookWorkflow handles it without branching.
	state := store.snapshot()
	defaultSteps := []workspaceWorkflowStep{
		{AgentID: "planner",    SectionID: "wf-planning",  Label: "Plan"},
		{AgentID: "builder",    SectionID: "wf-building",  Label: "Build"},
		{AgentID: "executor",   SectionID: "wf-executing", Label: "Execute"},
		{AgentID: "analyst",    SectionID: "wf-analysis",  Label: "Analyze"},
		{AgentID: "summarizer", SectionID: "wf-review",    Label: "Summarize"},
	}
	firstStep := defaultSteps[0]
	assigneeName := ""
	for _, m := range state.TeamMembers {
		if m.ID == firstStep.AgentID {
			assigneeName = m.Name
			break
		}
	}
	defaultTeamID := ""
	if len(state.Teams) > 0 {
		defaultTeamID = state.Teams[0].ID
	}

	now := time.Now().UTC()
	taskID := fmt.Sprintf("alarm-%d", now.UnixMilli())
	taskTitle := fmt.Sprintf("[%s] %s · %s",
		strings.ToUpper(level), source, title)
	task := workspaceTask{
		ID:              taskID,
		Title:           taskTitle,
		Description:     summary,
		Assignee:        assigneeName,
		Status:          firstStep.SectionID,
		CreatedAt:       now.Format(time.RFC3339),
		Date:            now.In(time.FixedZone("KST", 9*60*60)).Format("2006-01-02"),
		TeamID:          defaultTeamID,
		AgentID:         firstStep.AgentID,
		Execution:       "queued",
		WorkflowEnabled: true,
		WorkflowStep:    0,
		WorkflowSteps:   defaultSteps,
		AutoRun:         true,
	}
	if err := store.addTask(task); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to create task"})
		return
	}
	_ = store.addSessionLog(workspaceSessionLog{
		ID:        fmt.Sprintf("item-%d-wh-alarm", now.UnixMilli()),
		Title:     fmt.Sprintf("긴급 알람 수신 (%s)", strings.ToUpper(level)),
		UpdatedAt: now.Format(time.RFC3339),
		Summary:   fmt.Sprintf("'%s'에서 %s 알람 수신. 워크플로 자동 시작.", source, strings.ToUpper(level)),
	})
	go s.runWebhookWorkflow(workspaceID, taskID)
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "accepted", "taskId": taskID})
}
