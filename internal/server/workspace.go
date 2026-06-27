package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

type workspaceState struct {
	BoardTitle    string                        `json:"boardTitle"`
	Sections      []workspaceSection            `json:"sections"`
	Tasks         []workspaceTask               `json:"tasks"`
	Settings      workspaceSettings             `json:"workspaceSettings"`
	Teams         []workspaceTeam               `json:"teams"`
	TeamMembers   []workspaceAgent              `json:"teamMembers"`
	VaultDocs     []workspaceVaultDoc           `json:"vaultDocs"`
	Providers     []workspaceProvider           `json:"providers"`
	Channels      []workspaceChannel            `json:"channels"`
	Sessions      []workspaceSessionLog         `json:"sessions"`
	BossReports   []workspaceReport             `json:"bossReports"`
	WebhookConfig workspaceWebhookConfig        `json:"webhookConfig"`
	Notifications []workspaceNotificationTarget `json:"notifications"`
}

type workspaceWebhookConfig struct {
	Token   string `json:"token"`
	Enabled bool   `json:"enabled"`
	Masked  bool   `json:"masked,omitempty"`
}

type workspaceNotificationTarget struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
	Masked  bool   `json:"masked,omitempty"`
}

func (c workspaceWebhookConfig) redacted() workspaceWebhookConfig {
	return workspaceWebhookConfig{
		Token:   "",
		Enabled: c.Enabled,
		Masked:  true,
	}
}

func redactWorkspaceSecrets(state workspaceState) workspaceState {
	cloned := cloneWorkspaceState(state)
	cloned.WebhookConfig = cloned.WebhookConfig.redacted()
	if len(cloned.Notifications) > 0 {
		for i := range cloned.Notifications {
			cloned.Notifications[i].URL = ""
			cloned.Notifications[i].Masked = true
		}
	}
	return cloned
}

func preserveProtectedWorkspaceSecrets(next, current workspaceState) workspaceState {
	next.WebhookConfig = current.WebhookConfig
	next.Notifications = append([]workspaceNotificationTarget(nil), current.Notifications...)
	return next
}

func canManageWorkspaceSecrets(role string, isAdmin bool) bool {
	return isAdmin || role == "owner"
}

func validateNotificationTargets(targets []workspaceNotificationTarget) error {
	for _, target := range targets {
		raw := strings.TrimSpace(target.URL)
		if raw == "" {
			return fmt.Errorf("notification url is required")
		}
		u, err := url.Parse(raw)
		if err != nil {
			return fmt.Errorf("invalid notification url")
		}
		if !u.IsAbs() || u.Host == "" {
			return fmt.Errorf("notification url must be absolute")
		}
		switch strings.ToLower(u.Scheme) {
		case "https":
		case "http":
			if !isPublicNotificationHost(u.Hostname()) {
				return fmt.Errorf("notification url must not target localhost or private networks")
			}
		default:
			return fmt.Errorf("notification url must use http or https")
		}
	}
	return nil
}

func isPublicNotificationHost(host string) bool {
	host = strings.TrimSpace(strings.Trim(host, "[]"))
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return false
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsMulticast()
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		lower := strings.ToLower(host)
		return !strings.HasSuffix(lower, ".local") && !strings.HasSuffix(lower, ".internal")
	}
	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip)
		if !ok {
			return false
		}
		if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsMulticast() {
			return false
		}
	}
	return true
}

type workspaceSection struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type workspaceWorkflowStep struct {
	AgentID   string `json:"agentId"`
	SectionID string `json:"sectionId"`
	Label     string `json:"label"`
}

type workspaceTask struct {
	ID              string                  `json:"id"`
	Title           string                  `json:"title"`
	Description     string                  `json:"description"`
	Assignee        string                  `json:"assignee"`
	Status          string                  `json:"status"`
	CreatedAt       string                  `json:"createdAt"`
	Date            string                  `json:"date"`
	TeamID          string                  `json:"teamId"`
	AgentID         string                  `json:"agentId"`
	Execution       string                  `json:"executionStatus"`
	StartedAt       string                  `json:"startedAt"`
	ReportID        string                  `json:"reportId"`
	WorkflowEnabled bool                    `json:"workflowEnabled"`
	WorkflowStep    int                     `json:"workflowStep"`
	WorkflowSteps   []workspaceWorkflowStep `json:"workflowSteps"`
	AccContext      string                  `json:"accumulatedContext"`
	AutoRun         bool                    `json:"autoRun"`
	RetryCount      int                     `json:"retryCount,omitempty"`
	Attachments     []workspaceAttachment   `json:"attachments,omitempty"`
	// Markers are user-applied "sticker" tags ("review", future: "important",
	// "reference", …) used as a bookmark / flag mechanism. Stored as a string
	// slice so multiple stickers can coexist on one task without a migration
	// when new sticker types are added. Optional; old workspaces without the
	// field unmarshal to nil and behave as "no markers".
	Markers []string `json:"markers,omitempty"`
	// DeletedAt is set when the user soft-deletes the task. The row is kept
	// in workspace state (and visible in the trash UI) until it ages past
	// trashRetention, at which point normalize hard-deletes it along with
	// its attachments directory. RFC3339 in UTC, empty when not deleted.
	DeletedAt string `json:"deletedAt,omitempty"`
	// ImageOutput routes the LLM call to an image-generation model. When set,
	// the response PNG/JPEG is saved as a fresh attachment on the same task
	// and the boss report points at it. Useful for "design a favicon",
	// "draw a logo", etc.
	ImageOutput bool `json:"imageOutput,omitempty"`
	// ImageGridCount asks the image model to lay out N variations on a single
	// canvas (1 = single image / no grid). Only meaningful when ImageOutput
	// is true. Server clamps to allowed values to keep the prompt addition
	// stable and avoid odd layouts.
	ImageGridCount int `json:"imageGridCount,omitempty"`
}

// trashRetention is how long a soft-deleted task lingers in the trash before
// being permanently purged on the next normalize() pass. Tuned to "long
// enough to notice you deleted the wrong thing", not as an archive.
const trashRetention = 7 * 24 * time.Hour

// workspaceAttachment is metadata for a user-uploaded file attached to a task.
// The actual file bytes live on disk at .data/attachments/<taskID>/<storedName>.
type workspaceAttachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`       // original filename as uploaded
	Size       int64  `json:"size"`       // bytes
	MIME       string `json:"mime"`       // detected or client-reported content-type
	StoredName string `json:"storedName"` // on-disk filename (uuid-prefixed, sanitized)
	UploadedAt string `json:"uploadedAt"` // RFC3339
}

// maxAutoRetries is the cap on how many times a watchdog will auto-respawn a
// stuck/orphaned task before releasing it back to the queue for manual restart.
// Override with MAX_AUTO_RETRIES env var (default: 3).
func maxAutoRetries() int {
	if v := os.Getenv("MAX_AUTO_RETRIES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return 3
}

type workspaceSettings struct {
	OrchestrationMode string `json:"orchestrationMode"`
	PromptMode        string `json:"promptMode"`
	MemoryLevel       string `json:"memoryLevel"`
	// DisplayName is the label the agent should use when addressing the user
	// (replaces the legacy hardcoded "보스"). Empty → fall back to the login
	// username, then to "보스".
	DisplayName string `json:"displayName"`
	// IdleLogoutMinutes is the soft idle threshold for the frontend's
	// auto-logout watcher. 0 = disabled (absolute 8h ceiling still applies).
	// Pointer so we can distinguish "not set in JSON" (→ default 15) from
	// "explicitly disabled" (0). normalize() resolves the pointer to a
	// concrete value before save.
	IdleLogoutMinutes *int `json:"idleLogoutMinutes,omitempty"`
	// AgentMode gates who executes workflows:
	//   "ai"  (default) — the LLM agent runs the 5-step workflow as usual.
	//   "mcp"           — the LLM is FULLY blocked (runAgentTask refuses);
	//                     webhook alarms and manual runs are handled by the
	//                     deterministic MCP runbook runner instead, which
	//                     executes the runbook's [MCP] tool steps and files
	//                     the raw outputs as the report. String (not bool) so
	//                     legacy states without the field decode to "" and
	//                     normalize to "ai" instead of silently flipping off.
	AgentMode string `json:"agentMode"`
}

// defaultIdleLogoutMinutes is the fallback when the workspace doesn't have
// an explicit value. Matches the frontend's emptyWorkspace default.
const defaultIdleLogoutMinutes = 15

// allowedIdleLogoutMinutes is the set of options the UI exposes. Server
// clamps to one of these (or 0) to avoid an attacker writing arbitrary
// timeout values via PUT /api/workspace.
var allowedIdleLogoutMinutes = map[int]struct{}{
	0: {}, 5: {}, 15: {}, 30: {}, 60: {},
}

type workspaceAgent struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	TeamID string `json:"teamId"`
	Status string `json:"status"`
}

type workspaceTeam struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Mission string `json:"mission"`
}

type workspaceVaultDoc struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Note  string `json:"note"`
}

type workspaceProvider struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Model   string `json:"model"`
	Enabled bool   `json:"enabled"`
}

type workspaceChannel struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	Enabled bool   `json:"enabled"`
}

type workspaceSessionLog struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
	Summary   string `json:"summary"`
}

type workspaceReport struct {
	ID              string                  `json:"id"`
	TaskID          string                  `json:"taskId"`
	TeamID          string                  `json:"teamId"`
	AgentID         string                  `json:"agentId"`
	Title           string                  `json:"title"`
	TaskTitle       string                  `json:"taskTitle,omitempty"`
	Summary         string                  `json:"summary"`
	DeliveredAt     string                  `json:"deliveredAt"`
	Status          string                  `json:"status"`
	WorkflowEnabled bool                    `json:"workflowEnabled,omitempty"`
	WorkflowStep    int                     `json:"workflowStep"`
	WorkflowSteps   []workspaceWorkflowStep `json:"workflowSteps,omitempty"`
	// TrustScore gates whether this report is allowed into the prompt-
	// injection path of the FTS5 RAG (단계 1, plan/rag-and-memory-roadmap.md).
	//
	//   0.0  — explicitly demoted ("이 리포트 잘못됨")
	//   0.5  — default for auto-generated reports (user search OK, LLM inject blocked)
	//   1.0  — explicitly approved via Boss Inbox "지식베이스 등록" toggle
	//
	// "옵션 C": 모든 리포트가 FTS5 인덱스에 들어가서 사용자 검색은 가능
	// 하지만, agent prompt 에 inject 될 때는 trust_score >= 0.7 만 통과.
	TrustScore float64 `json:"trustScore,omitempty"`
	ApprovedBy string  `json:"approvedBy,omitempty"` // user_id of the approver
	ApprovedAt string  `json:"approvedAt,omitempty"` // RFC3339 in UTC, empty when not approved
}

// workspaceStore is the in-memory + persistent state for a single
// workspace. Phase 11 moved the persistence layer from a single
// .data/workspace.json file (Phase 1 single-operator model) to one
// row per workspace in SQLite (workspaces.state_json). The store
// itself is unchanged at the API level — every existing method on
// *workspaceStore still works — but saveLocked now writes through
// `persist` instead of the filesystem and the registry below owns
// the lifecycle (one store per active workspaceID, lazy loaded).
type workspaceStore struct {
	mu          sync.RWMutex
	workspaceID string // empty for legacy fixtures; set in production
	state       workspaceState
	etag        string                                    // sha256 prefix of last saved state, used for HTTP ETag + dirty check
	persist     func(workspaceID, stateJSON string) error // DB writer; nil disables persistence (used by tests / legacy import)
	onChange    func(etag string)                         // optional: called after saveLocked() when state actually changed
	// searchSync rebuilds the FTS5 index for this workspace whenever the
	// state changes. Pluggable so tests and the legacy import path can
	// skip it (nil = no-op). Wired in bootstrapWorkspaces.
	searchSync func(workspaceID string, state workspaceState)
}

// computeETag returns a quoted ETag string derived from a stable JSON
// representation of the workspace state. Same input → same ETag, so we can
// cheaply tell whether two snapshots are identical.
func computeETag(state workspaceState) string {
	b, err := json.Marshal(state)
	if err != nil {
		return `""`
	}
	h := sha256.Sum256(b)
	return `"` + hex.EncodeToString(h[:])[:16] + `"`
}

// newWorkspaceStoreFromState builds a store around an already-loaded
// state blob. The registry uses this after pulling state_json from the
// DB. `persist` writes future updates back to the DB; `workspaceID`
// is stamped into every persist call so the writer knows which row
// to UPDATE.
//
// State is normalized + saved once on construction. The save flushes
// any normalize-time changes (orphan recovery, default backfills) so
// the in-memory etag and the persisted row agree.
func newWorkspaceStoreFromState(workspaceID string, state workspaceState,
	persist func(workspaceID, stateJSON string) error) (*workspaceStore, error) {
	store := &workspaceStore{
		workspaceID: workspaceID,
		state:       normalizeWorkspaceState(state),
		persist:     persist,
	}
	if err := store.saveLocked(); err != nil {
		return nil, err
	}
	// Boot-time orphan sweep: any attachments/{taskID}/ directory whose
	// task is no longer in state is removed from disk. The sweep stays
	// file-system based because attachments themselves are still on
	// disk (Phase 5 will scope by workspaceID, but the sweep API is
	// unchanged).
	store.sweepOrphanAttachments()
	return store, nil
}

func (s *workspaceStore) snapshot() workspaceState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneWorkspaceState(s.state)
}

// replace overwrites the workspace state. If the normalized next state hashes
// identical to the currently-stored one, the disk write and the onChange
// callback are skipped (dirty check).
func (s *workspaceStore) replace(next workspaceState) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	normalized := normalizeWorkspaceState(next)
	if computeETag(normalized) == s.etag && s.etag != "" {
		// Same state — no work to do.
		return nil
	}
	s.state = normalized
	return s.saveLocked()
}

// setTaskExecution updates a task's executionStatus and optionally marks the agent busy.
func (s *workspaceStore) setTaskExecution(taskID, status, agentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	found := false
	for i, t := range s.state.Tasks {
		if t.ID == taskID {
			prev := s.state.Tasks[i].Execution
			s.state.Tasks[i].Execution = status
			if status == "active" {
				s.state.Tasks[i].StartedAt = time.Now().UTC().Format(time.RFC3339)
			} else {
				s.state.Tasks[i].StartedAt = ""
			}
			if prev != status {
				logger.Info("[task] status change", "task", taskID, "from", prev, "to", status)
			}
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("task not found: %s", taskID)
	}

	if agentID != "" && status == "active" {
		for i, m := range s.state.TeamMembers {
			if m.ID == agentID {
				s.state.TeamMembers[i].Status = "busy"
				break
			}
		}
	}

	return s.saveLocked()
}

// completeTaskWithReport marks a task completed, sets agent idle, and appends a boss report.
func (s *workspaceStore) completeTaskWithReport(taskID string, agent workspaceAgent, team workspaceTeam, reportText string) (workspaceState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Find done section
	doneSectionID := ""
	for _, sec := range s.state.Sections {
		if strings.EqualFold(sec.Title, "done") {
			doneSectionID = sec.ID
			break
		}
	}
	if doneSectionID == "" && len(s.state.Sections) > 0 {
		doneSectionID = s.state.Sections[len(s.state.Sections)-1].ID
	}

	now := time.Now().UTC()
	reportID := fmt.Sprintf("report-%s-%06d", now.Format("20060102150405"), now.Nanosecond()/1000)
	taskTitle := ""
	reportTitle := ""
	taskWorkflowEnabled := false
	taskWorkflowStep := 0
	var taskWorkflowSteps []workspaceWorkflowStep

	for i, t := range s.state.Tasks {
		if t.ID == taskID {
			taskTitle = t.Title
			taskWorkflowEnabled = t.WorkflowEnabled
			taskWorkflowStep = t.WorkflowStep
			taskWorkflowSteps = append([]workspaceWorkflowStep(nil), t.WorkflowSteps...)
			s.state.Tasks[i].Execution = "completed"

			// Workflow tasks: only move to Done on the last step.
			// All other steps stay in the current section — the frontend
			// advances the section/agent on boss approval.
			//
			// Non-workflow tasks: always move to Done on completion.
			// rejectReport moves the task to Building so the user sees
			// "rerun in progress"; once the LLM finishes the result has
			// landed and the task is done again. Frontend spotlight on
			// reject keeps the transient Building visit noticeable.
			isLastStep := !t.WorkflowEnabled || t.WorkflowStep >= len(t.WorkflowSteps)-1
			if isLastStep && doneSectionID != "" {
				s.state.Tasks[i].Status = doneSectionID
			}

			// Append this step's report to accumulated context and build title
			if t.WorkflowEnabled {
				stepLabel := ""
				if t.WorkflowStep < len(t.WorkflowSteps) {
					stepLabel = t.WorkflowSteps[t.WorkflowStep].Label
				}
				sep := fmt.Sprintf("\n\n--- Step %d/%d (%s) ---\n",
					t.WorkflowStep+1, len(t.WorkflowSteps), stepLabel)
				s.state.Tasks[i].AccContext += sep + reportText
				reportTitle = fmt.Sprintf("%s · Step %d/%d (%s)",
					t.Title, t.WorkflowStep+1, len(t.WorkflowSteps), stepLabel)
			}

			// Two routing modes:
			//
			//  • Workflow steps always get a fresh ReportID — each step is
			//    semantically its own work item, and the inbox is supposed
			//    to chronicle the pipeline (1/5, 2/5, …).
			//
			//  • Non-workflow tasks REUSE an existing ReportID when one is
			//    set. A re-run is "do this same request again", and the
			//    user expects the inbox / task card to show one row whose
			//    content has been refreshed — not a stack of historical
			//    attempts. The reject event itself is preserved in the
			//    session log, so we don't lose the audit trail.
			//
			//  • First-time runs (ReportID == "") always allocate a fresh ID.
			if t.WorkflowEnabled {
				s.state.Tasks[i].ReportID = reportID
			} else if s.state.Tasks[i].ReportID == "" {
				s.state.Tasks[i].ReportID = reportID
			} else {
				reportID = s.state.Tasks[i].ReportID
			}
			break
		}
	}

	if reportTitle == "" {
		reportTitle = taskTitle + " 완료"
	}

	// Agent back to idle
	if agent.ID != "" {
		for i, m := range s.state.TeamMembers {
			if m.ID == agent.ID {
				s.state.TeamMembers[i].Status = "idle"
				break
			}
		}
	}

	// Save the report. If a report with this ID already exists (manual-close
	// stub, or a previous run of this same non-workflow task), REPLACE its
	// content in place — that's what makes "Done card" and "Inbox" agree on
	// "one row per task". For workflow steps and first runs the ID is fresh,
	// so foundIdx will be -1 and we prepend a new row.
	foundIdx := -1
	for i, r := range s.state.BossReports {
		if r.ID == reportID {
			foundIdx = i
			break
		}
	}
	if foundIdx >= 0 {
		prevLen := len(s.state.BossReports[foundIdx].Summary)
		s.state.BossReports[foundIdx].TaskID = taskID
		s.state.BossReports[foundIdx].TeamID = team.ID
		s.state.BossReports[foundIdx].AgentID = agent.ID
		s.state.BossReports[foundIdx].Title = reportTitle
		s.state.BossReports[foundIdx].TaskTitle = taskTitle
		s.state.BossReports[foundIdx].Summary = reportText
		s.state.BossReports[foundIdx].DeliveredAt = time.Now().UTC().Format(time.RFC3339)
		s.state.BossReports[foundIdx].Status = "new"
		s.state.BossReports[foundIdx].WorkflowEnabled = taskWorkflowEnabled
		s.state.BossReports[foundIdx].WorkflowStep = taskWorkflowStep
		s.state.BossReports[foundIdx].WorkflowSteps = append([]workspaceWorkflowStep(nil), taskWorkflowSteps...)
		logger.Info("[report] updated", "report", reportID, "task", taskID, "prevBytes", prevLen, "newBytes", len(reportText))
	} else {
		report := workspaceReport{
			ID:              reportID,
			TaskID:          taskID,
			TeamID:          team.ID,
			AgentID:         agent.ID,
			Title:           reportTitle,
			TaskTitle:       taskTitle,
			Summary:         reportText,
			DeliveredAt:     time.Now().UTC().Format(time.RFC3339),
			Status:          "new",
			WorkflowEnabled: taskWorkflowEnabled,
			WorkflowStep:    taskWorkflowStep,
			WorkflowSteps:   append([]workspaceWorkflowStep(nil), taskWorkflowSteps...),
			TrustScore:      0.5, // auto-generated, user must approve for LLM-inject
		}
		s.state.BossReports = append([]workspaceReport{report}, s.state.BossReports...)
		logger.Info("[report] created", "report", reportID, "task", taskID, "bytes", len(reportText))
	}

	if err := s.saveLocked(); err != nil {
		return workspaceState{}, err
	}

	return cloneWorkspaceState(s.state), nil
}

// addBossReportOnly prepends a standalone boss report to the inbox without
// touching tasks. Used by the webhook ingest path for low-severity alarms
// (info/warning) that should surface as a notification but not trigger the
// 5-step LLM workflow. TaskID is empty so the inbox card renders without a
// back-link; ReportCard already handles that case (no 보고서 → 태스크 jump).
func (s *workspaceStore) addBossReportOnly(title, summary string) (workspaceState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339)
	report := workspaceReport{
		ID:          fmt.Sprintf("report-wh-%d", time.Now().UnixMilli()),
		TaskID:      "",
		TeamID:      "",
		AgentID:     "",
		Title:       title,
		Summary:     summary,
		DeliveredAt: now,
		Status:      "new",
	}
	s.state.BossReports = append([]workspaceReport{report}, s.state.BossReports...)

	if err := s.saveLocked(); err != nil {
		return workspaceState{}, err
	}
	return cloneWorkspaceState(s.state), nil
}

// setReportTrust adjusts the report's TrustScore + Approved* fields and
// re-saves. Used by the Boss Inbox "지식베이스 등록" toggle (Stage 1-B).
//
//	trust = 1.0 + approver != "": approval (knowledge-base register)
//	trust = 0.0 + approver != "": demotion
//	trust = 0.5 + approver == "": reset to default (uncategorized)
//
// Returns an error if the report doesn't exist. saveLocked then triggers
// the FTS5 sync so the new trust_score lands in the search index in the
// same tick — agent inject path sees the change on the next call.
func (s *workspaceStore) setReportTrust(reportID string, trust float64, approverUserID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.state.BossReports {
		if r.ID != reportID {
			continue
		}
		s.state.BossReports[i].TrustScore = trust
		if approverUserID == "" {
			s.state.BossReports[i].ApprovedBy = ""
			s.state.BossReports[i].ApprovedAt = ""
		} else {
			s.state.BossReports[i].ApprovedBy = approverUserID
			s.state.BossReports[i].ApprovedAt = time.Now().UTC().Format(time.RFC3339)
		}
		return s.saveLocked()
	}
	return fmt.Errorf("report not found: %s", reportID)
}

func (s *workspaceStore) searchVault(query string) []workspaceVaultDoc {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query = strings.TrimSpace(strings.ToLower(query))
	if query == "" {
		return cloneVaultDocs(s.state.VaultDocs)
	}

	var results []workspaceVaultDoc
	for _, doc := range s.state.VaultDocs {
		haystack := strings.ToLower(doc.Title + " " + doc.Note)
		if strings.Contains(haystack, query) {
			results = append(results, doc)
		}
	}

	return results
}

func (s *workspaceStore) saveLocked() error {
	body, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}

	// Phase 11: persistence is pluggable. Production wires it to the
	// workspaces.state_json column (one row per workspace). Tests and
	// the legacy one-shot import path leave persist nil to keep the
	// state in memory only.
	if s.persist != nil {
		if err := s.persist(s.workspaceID, string(body)); err != nil {
			return err
		}
	}

	// Recompute ETag and broadcast the change so SSE subscribers can refresh.
	s.etag = computeETag(s.state)
	if s.onChange != nil {
		// Fire outside the lock by calling synchronously after work is done.
		// Caller guarantees onChange is fast (just a non-blocking publish).
		s.onChange(s.etag)
	}
	// Stage-1 RAG: rebuild the FTS5 index for this workspace. Best-effort —
	// callback is expected to log + swallow errors so a search-index hiccup
	// can't block a workspace save.
	if s.searchSync != nil {
		s.searchSync(s.workspaceID, s.state)
	}
	return nil
}

// getETag returns the current ETag (for HTTP If-Match / If-None-Match handling).
func (s *workspaceStore) getETag() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.etag
}

func defaultWorkspaceState() workspaceState {
	now := time.Now().UTC().Format(time.RFC3339)
	return workspaceState{
		BoardTitle: "Workspace",
		Sections: []workspaceSection{
			{ID: "backlog", Title: "Backlog"},
			{ID: "wf-planning", Title: "Planning"},
			{ID: "wf-building", Title: "Building"},
			{ID: "wf-executing", Title: "Executing"},
			{ID: "wf-analysis", Title: "Analysis"},
			{ID: "wf-review", Title: "Review"},
			{ID: "done", Title: "Done"},
		},
		Tasks: []workspaceTask{},
		Settings: workspaceSettings{
			OrchestrationMode: "auto",
			PromptMode:        "task",
			MemoryLevel:       "L1",
			IdleLogoutMinutes: func() *int { v := defaultIdleLogoutMinutes; return &v }(),
			AgentMode:         "ai",
		},
		Teams: []workspaceTeam{
			{ID: "alpha-team", Name: "Alpha Team", Mission: "Plan, build, and report back to the boss."},
		},
		TeamMembers: []workspaceAgent{
			{ID: "planner", Name: "Planner", Role: "Breaks tasks into steps and creates a plan", TeamID: "alpha-team", Status: "idle"},
			{ID: "builder", Name: "Builder", Role: "Implements and verifies changes", TeamID: "alpha-team", Status: "idle"},
			{ID: "executor", Name: "Executor", Role: "Executes the plan and collects data", TeamID: "alpha-team", Status: "idle"},
			{ID: "analyst", Name: "Analyst", Role: "Analyzes data and produces statistics", TeamID: "alpha-team", Status: "idle"},
			{ID: "summarizer", Name: "Summarizer", Role: "Summarizes findings and writes final report", TeamID: "alpha-team", Status: "idle"},
		},
		VaultDocs: []workspaceVaultDoc{
			{ID: "architecture", Title: "Architecture", Note: "System rules and constraints"},
			{ID: "runbook", Title: "Runbook", Note: "Deployment and recovery steps"},
		},
		Providers: []workspaceProvider{
			{ID: "openai", Name: "OpenAI (Codex)", Model: "o4-mini", Enabled: true},
			{ID: "gemini", Name: "Google Gemini", Model: "gemini-3-flash-preview", Enabled: false},
			{ID: "anthropic", Name: "Anthropic", Model: "claude-sonnet-4-5-20251001", Enabled: false},
		},
		Channels: []workspaceChannel{
			{ID: "web", Name: "Web", Status: "Connected", Enabled: true},
			{ID: "slack", Name: "Slack", Status: "Idle", Enabled: false},
			{ID: "discord", Name: "Discord", Status: "Idle", Enabled: false},
		},
		Sessions: []workspaceSessionLog{
			{ID: "session-1", Title: "Initial workspace", UpdatedAt: now, Summary: "Workspace created with default board."},
		},
		BossReports:   []workspaceReport{},
		WebhookConfig: workspaceWebhookConfig{Token: generateToken(), Enabled: false},
		Notifications: []workspaceNotificationTarget{},
	}
}

func generateToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func isLastWorkflowStep(t workspaceTask) bool {
	return len(t.WorkflowSteps) == 0 || t.WorkflowStep >= len(t.WorkflowSteps)-1
}

// purgeExpiredTrash drops tasks whose DeletedAt timestamp is older than
// trashRetention before `now`. Tasks with no DeletedAt are kept untouched.
// Returns a new slice; the input is not mutated.
func purgeExpiredTrash(tasks []workspaceTask, now time.Time) []workspaceTask {
	if len(tasks) == 0 {
		return tasks
	}
	cutoff := now.Add(-trashRetention)
	kept := make([]workspaceTask, 0, len(tasks))
	for _, t := range tasks {
		if t.DeletedAt == "" {
			kept = append(kept, t)
			continue
		}
		ts, err := time.Parse(time.RFC3339, t.DeletedAt)
		if err != nil {
			// Malformed timestamp — refuse to purge so we don't lose data
			// silently. Keep the row; the user can clear it from the UI.
			kept = append(kept, t)
			continue
		}
		if ts.Before(cutoff) {
			logger.Info("trash purge: dropping task", "task", t.ID, "deletedAt", t.DeletedAt)
			continue
		}
		kept = append(kept, t)
	}
	return kept
}

func normalizeWorkspaceState(state workspaceState) workspaceState {
	if strings.TrimSpace(state.BoardTitle) == "" {
		state.BoardTitle = "Workspace"
	}

	if state.Tasks == nil {
		state.Tasks = []workspaceTask{}
	}

	// Startup orphan recovery: when the server starts there are no live goroutines,
	// so any task left in "active" or "retrying" is definitely abandoned.
	// Reset them immediately to "queued" so users can retry without waiting for the
	// background scanner (which would take up to 3 minutes otherwise).
	// Workflow progress (workflowStep, accumulatedContext) is preserved, so the
	// task resumes from exactly where it left off.
	{
		agentIDs := make(map[string]struct{})
		for i, t := range state.Tasks {
			if t.Execution == "active" || t.Execution == "retrying" {
				state.Tasks[i].Execution = "queued"
				state.Tasks[i].StartedAt = ""
				if t.AgentID != "" {
					agentIDs[t.AgentID] = struct{}{}
				}
			}
		}
		for i, m := range state.TeamMembers {
			if _, stuck := agentIDs[m.ID]; stuck {
				state.TeamMembers[i].Status = "idle"
			}
		}
	}

	// Orphaned-completed recovery: a workflow task that is "completed" but has no
	// corresponding boss report (reportId=="" and no "new" report in bossReports)
	// means the agent ran but the report was lost (e.g. ID collision, race).
	// Reset such tasks to "queued" so the step can be re-run automatically.
	{
		newReportTaskIDs := make(map[string]struct{})
		for _, r := range state.BossReports {
			if r.Status == "new" {
				newReportTaskIDs[r.TaskID] = struct{}{}
			}
		}
		for i, t := range state.Tasks {
			if t.DeletedAt != "" {
				continue // skip trashed tasks
			}
			// Orphan recovery covers two shapes:
			//
			//  1. Workflow step stuck completed without its report (mid-workflow):
			//     reset to queued so the step re-runs.
			//  2. Non-workflow task that finished but lost its ReportID (race
			//     between reject + rerun, or partial save). User would see no
			//     report and no "재실행" trigger that does anything useful;
			//     resetting to queued lets the next "재실행" actually re-run.
			isWorkflowOrphan := t.WorkflowEnabled &&
				t.Execution == "completed" &&
				t.ReportID == "" &&
				!isLastWorkflowStep(t)
			isPlainOrphan := !t.WorkflowEnabled &&
				t.Execution == "completed" &&
				t.ReportID == ""
			if isWorkflowOrphan || isPlainOrphan {
				if _, hasReport := newReportTaskIDs[t.ID]; !hasReport {
					logger.Warn("orphan-completed recovery: task has no boss report — resetting to queued",
						"task", t.ID, "workflow", t.WorkflowEnabled, "step", t.WorkflowStep)
					state.Tasks[i].Execution = "queued"
					state.Tasks[i].StartedAt = ""
				}
			}
		}
	}

	// Trash purge: drop soft-deleted tasks older than trashRetention. Tasks
	// still within the retention window stay in state.Tasks (with deletedAt
	// set) so the UI can list / restore them. Their attachment directories
	// remain on disk for now — the store's boot-time orphan sweep removes
	// any attachment folder whose task ID is no longer present in state.
	state.Tasks = purgeExpiredTrash(state.Tasks, time.Now().UTC())
	if state.Notifications == nil {
		state.Notifications = []workspaceNotificationTarget{}
	}
	// Ensure webhook has a token
	if state.WebhookConfig.Token == "" {
		state.WebhookConfig.Token = generateToken()
	}
	if state.Teams == nil {
		state.Teams = []workspaceTeam{}
	}
	if state.TeamMembers == nil {
		state.TeamMembers = []workspaceAgent{}
	}
	if state.VaultDocs == nil {
		state.VaultDocs = []workspaceVaultDoc{}
	}
	if state.Providers == nil {
		state.Providers = []workspaceProvider{}
	}
	if state.Channels == nil {
		state.Channels = []workspaceChannel{}
	}
	if state.Sessions == nil {
		state.Sessions = []workspaceSessionLog{}
	}
	if state.BossReports == nil {
		state.BossReports = []workspaceReport{}
	}
	// Stage-1 RAG: any pre-existing report stored before TrustScore landed
	// gets the auto-generated default (0.5). Approved reports keep their
	// explicit 1.0; demote sets 0.0 and we don't want to overwrite that.
	for i, r := range state.BossReports {
		if r.TrustScore == 0 && r.ApprovedAt == "" {
			state.BossReports[i].TrustScore = 0.5
		}
	}

	if len(state.Sections) == 0 {
		state.Sections = defaultWorkspaceState().Sections
	}
	if len(state.Teams) == 0 {
		state.Teams = defaultWorkspaceState().Teams
	}
	for i, team := range state.Teams {
		if strings.TrimSpace(team.ID) == "" {
			state.Teams[i].ID = "team-" + time.Now().UTC().Format("150405")
		}
		if strings.TrimSpace(team.Name) == "" {
			state.Teams[i].Name = "Untitled Team"
		}
	}
	for i, section := range state.Sections {
		if strings.TrimSpace(section.ID) == "" {
			state.Sections[i].ID = "section-" + time.Now().UTC().Format("150405")
		}
		if strings.TrimSpace(section.Title) == "" {
			state.Sections[i].Title = "Untitled"
		}
	}

	sectionIDs := make([]string, 0, len(state.Sections))
	for _, section := range state.Sections {
		sectionIDs = append(sectionIDs, section.ID)
	}
	teamIDs := make([]string, 0, len(state.Teams))
	for _, team := range state.Teams {
		teamIDs = append(teamIDs, team.ID)
	}

	defaultSectionID := state.Sections[0].ID
	defaultTeamID := state.Teams[0].ID
	agentIDs := make([]string, 0, len(state.TeamMembers))
	for i, agent := range state.TeamMembers {
		if strings.TrimSpace(agent.ID) == "" {
			state.TeamMembers[i].ID = "agent-" + time.Now().UTC().Format("150405")
		}
		if strings.TrimSpace(agent.Name) == "" {
			state.TeamMembers[i].Name = "Agent"
		}
		if !slices.Contains(teamIDs, agent.TeamID) {
			state.TeamMembers[i].TeamID = defaultTeamID
		}
		// busy 상태로 남은 에이전트는 서버 재시작으로 인해 중단된 것이므로 idle로 복구
		if agent.Status == "busy" || !slices.Contains([]string{"idle", "busy", "offline"}, agent.Status) {
			state.TeamMembers[i].Status = "idle"
		}
		agentIDs = append(agentIDs, state.TeamMembers[i].ID)
	}
	for i, task := range state.Tasks {
		if strings.TrimSpace(task.ID) == "" {
			state.Tasks[i].ID = "task-" + time.Now().UTC().Format("150405")
		}
		if strings.TrimSpace(task.Title) == "" {
			state.Tasks[i].Title = "Untitled"
		}
		if !slices.Contains(sectionIDs, task.Status) {
			state.Tasks[i].Status = defaultSectionID
		}
		if strings.TrimSpace(task.CreatedAt) == "" {
			state.Tasks[i].CreatedAt = time.Now().UTC().Format(time.RFC3339)
		}
		if !slices.Contains(teamIDs, task.TeamID) {
			state.Tasks[i].TeamID = defaultTeamID
		}
		if strings.TrimSpace(task.AgentID) != "" && !slices.Contains(agentIDs, task.AgentID) {
			state.Tasks[i].AgentID = ""
		}
		// active 상태로 남은 태스크는 서버 재시작으로 인해 중단된 것이므로 queued로 복구
		if task.Execution == "active" || !slices.Contains([]string{"queued", "active", "completed"}, task.Execution) {
			state.Tasks[i].Execution = "queued"
		}
	}

	if !slices.Contains([]string{"auto", "explicit", "manual"}, state.Settings.OrchestrationMode) {
		state.Settings.OrchestrationMode = "auto"
	}
	if !slices.Contains([]string{"full", "task", "minimal", "none"}, state.Settings.PromptMode) {
		state.Settings.PromptMode = "task"
	}
	if !slices.Contains([]string{"L0", "L1", "L2"}, state.Settings.MemoryLevel) {
		state.Settings.MemoryLevel = "L1"
	}
	// "" covers legacy states saved before the field existed → AI stays on.
	if !slices.Contains([]string{"ai", "mcp"}, state.Settings.AgentMode) {
		state.Settings.AgentMode = "ai"
	}

	// Idle logout: legacy workspaces without the field get the default;
	// values outside the allowed set get clamped to the default to keep
	// the UI dropdown honest. 0 is allowed (= disabled).
	if state.Settings.IdleLogoutMinutes == nil {
		v := defaultIdleLogoutMinutes
		state.Settings.IdleLogoutMinutes = &v
	} else if _, ok := allowedIdleLogoutMinutes[*state.Settings.IdleLogoutMinutes]; !ok {
		v := defaultIdleLogoutMinutes
		state.Settings.IdleLogoutMinutes = &v
	}

	if len(state.TeamMembers) == 0 {
		state.TeamMembers = defaultWorkspaceState().TeamMembers
	}
	if len(state.VaultDocs) == 0 {
		state.VaultDocs = defaultWorkspaceState().VaultDocs
	}
	if len(state.Providers) == 0 {
		state.Providers = defaultWorkspaceState().Providers
	}
	// Migrate legacy "openrouter" provider → "gemini"
	// Also correct any stale/invalid Gemini model names.
	for i, p := range state.Providers {
		switch p.ID {
		case "openrouter":
			state.Providers[i] = workspaceProvider{
				ID:      "gemini",
				Name:    "Google Gemini",
				Model:   "gemini-2.5-flash",
				Enabled: false,
			}
		case "gemini":
			if !isValidGeminiModel(p.Model) {
				state.Providers[i].Model = "gemini-2.5-flash"
			}
		}
	}
	if len(state.Channels) == 0 {
		state.Channels = defaultWorkspaceState().Channels
	}
	if len(state.Sessions) == 0 {
		state.Sessions = defaultWorkspaceState().Sessions
	}
	for i, report := range state.BossReports {
		if strings.TrimSpace(report.ID) == "" {
			state.BossReports[i].ID = "report-" + time.Now().UTC().Format("150405")
		}
		if !slices.Contains([]string{"new", "approved", "rejected"}, report.Status) {
			state.BossReports[i].Status = "new"
		}
		if strings.TrimSpace(report.DeliveredAt) == "" {
			state.BossReports[i].DeliveredAt = time.Now().UTC().Format(time.RFC3339)
		}
	}

	return state
}

func cloneWorkspaceState(state workspaceState) workspaceState {
	cloned := state
	cloned.Sections = append([]workspaceSection(nil), state.Sections...)
	cloned.Tasks = append([]workspaceTask(nil), state.Tasks...)
	cloned.Teams = append([]workspaceTeam(nil), state.Teams...)
	cloned.TeamMembers = append([]workspaceAgent(nil), state.TeamMembers...)
	cloned.VaultDocs = append([]workspaceVaultDoc(nil), state.VaultDocs...)
	cloned.Providers = append([]workspaceProvider(nil), state.Providers...)
	cloned.Channels = append([]workspaceChannel(nil), state.Channels...)
	cloned.Sessions = append([]workspaceSessionLog(nil), state.Sessions...)
	cloned.BossReports = append([]workspaceReport(nil), state.BossReports...)
	cloned.Notifications = append([]workspaceNotificationTarget(nil), state.Notifications...)
	if cloned.Tasks == nil {
		cloned.Tasks = []workspaceTask{}
	}
	if cloned.Teams == nil {
		cloned.Teams = []workspaceTeam{}
	}
	if cloned.TeamMembers == nil {
		cloned.TeamMembers = []workspaceAgent{}
	}
	if cloned.VaultDocs == nil {
		cloned.VaultDocs = []workspaceVaultDoc{}
	}
	if cloned.Providers == nil {
		cloned.Providers = []workspaceProvider{}
	}
	if cloned.Channels == nil {
		cloned.Channels = []workspaceChannel{}
	}
	if cloned.Sessions == nil {
		cloned.Sessions = []workspaceSessionLog{}
	}
	if cloned.BossReports == nil {
		cloned.BossReports = []workspaceReport{}
	}
	return cloned
}

func cloneVaultDocs(docs []workspaceVaultDoc) []workspaceVaultDoc {
	return append([]workspaceVaultDoc(nil), docs...)
}

// isValidGeminiModel returns true for model IDs that match real Google
// Gemini models. Reject hallucinated names from earlier code generations.
// advanceWorkflowStep appends the current step's report to accumulatedContext,
// then moves the task to the next workflow step without creating a boss report.
// Used by the auto-run webhook workflow for intermediate steps.
func (s *workspaceStore) advanceWorkflowStep(taskID string, nextStep int, reportText string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, t := range s.state.Tasks {
		if t.ID != taskID {
			continue
		}
		// Append this step's output to accumulated context
		stepLabel := ""
		if t.WorkflowStep < len(t.WorkflowSteps) {
			stepLabel = t.WorkflowSteps[t.WorkflowStep].Label
		}
		sep := fmt.Sprintf("\n\n--- Step %d/%d (%s) ---\n", t.WorkflowStep+1, len(t.WorkflowSteps), stepLabel)
		s.state.Tasks[i].AccContext += sep + reportText

		// Advance step
		nextStepDef := t.WorkflowSteps[nextStep]
		s.state.Tasks[i].WorkflowStep = nextStep
		s.state.Tasks[i].Status = nextStepDef.SectionID
		s.state.Tasks[i].AgentID = nextStepDef.AgentID
		s.state.Tasks[i].Execution = "queued"
		s.state.Tasks[i].ReportID = ""

		for _, m := range s.state.TeamMembers {
			if m.ID == nextStepDef.AgentID {
				s.state.Tasks[i].Assignee = m.Name
				break
			}
		}
		// Release current agent
		for j, m := range s.state.TeamMembers {
			if m.ID == t.AgentID {
				s.state.TeamMembers[j].Status = "idle"
				break
			}
		}
		break
	}
	return s.saveLocked()
}

// markStuckTasksRetrying finds tasks that have been active longer than threshold,
// marks them as "retrying", releases their agents, and returns the list so the
// caller can schedule a re-run for each one.
//
// Tasks that have already been auto-retried maxAutoRetries() times are NOT
// re-spawned: they're released to "queued" with the count reset, so the user
// must restart them manually. This is the cost cap against runaway loops.
func (s *workspaceStore) markStuckTasksRetrying(threshold time.Duration) []workspaceTask {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	maxR := maxAutoRetries()
	var stuck []workspaceTask
	changed := false

	for i, t := range s.state.Tasks {
		if t.Execution != "active" {
			continue
		}
		shouldRetry := false
		if t.StartedAt == "" {
			shouldRetry = true // 레거시 active 태스크
		} else {
			startedAt, err := time.Parse(time.RFC3339, t.StartedAt)
			if err == nil && now.Sub(startedAt) > threshold {
				shouldRetry = true
			}
		}
		if !shouldRetry {
			continue
		}

		// Free the agent regardless of cap decision.
		for j, m := range s.state.TeamMembers {
			if m.ID == t.AgentID {
				s.state.TeamMembers[j].Status = "idle"
				break
			}
		}

		// Cap exceeded — release to queue, don't auto-respawn.
		if t.RetryCount >= maxR {
			s.state.Tasks[i].Execution = "queued"
			s.state.Tasks[i].StartedAt = ""
			s.state.Tasks[i].RetryCount = 0
			logger.Warn("[watchdog] task exceeded auto-retry cap, released to manual queue", "task", t.ID, "cap", maxR)
			changed = true
			continue
		}

		s.state.Tasks[i].Execution = "retrying"
		s.state.Tasks[i].StartedAt = now.Format(time.RFC3339)
		s.state.Tasks[i].RetryCount++
		changed = true
		stuck = append(stuck, s.state.Tasks[i])
	}

	if changed {
		_ = s.saveLocked()
	}
	return stuck
}

// recoverOrphanedRetrying finds tasks that have been in "retrying" state longer
// than orphanThreshold (the rerunTask goroutine likely died without cleaning up),
// resets them to "queued", and returns them so the caller can schedule a fresh run.
// This is the fast-watchdog counterpart to markStuckTasksRetrying.
//
// Tasks past the auto-retry cap are dropped to "queued" without being added
// to the returned spawn list — the caller will not re-run them, so the user
// has to restart manually.
func (s *workspaceStore) recoverOrphanedRetrying(orphanThreshold time.Duration) []workspaceTask {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	maxR := maxAutoRetries()
	var orphaned []workspaceTask
	changed := false

	for i, t := range s.state.Tasks {
		if t.Execution != "retrying" {
			continue
		}
		isOrphan := false
		if t.StartedAt == "" {
			isOrphan = true // no timestamp → definitely orphaned
		} else {
			if ts, err := time.Parse(time.RFC3339, t.StartedAt); err == nil {
				isOrphan = now.Sub(ts) > orphanThreshold
			}
		}
		if !isOrphan {
			continue
		}

		s.state.Tasks[i].Execution = "queued"
		s.state.Tasks[i].StartedAt = ""
		changed = true

		// Cap exceeded — don't re-spawn. Reset count so manual restart is fresh.
		if t.RetryCount >= maxR {
			s.state.Tasks[i].RetryCount = 0
			logger.Warn("[watchdog] task exceeded auto-retry cap, released to manual queue", "task", t.ID, "cap", maxR)
			continue
		}

		s.state.Tasks[i].RetryCount++
		orphaned = append(orphaned, s.state.Tasks[i])
	}

	if changed {
		_ = s.saveLocked()
	}
	return orphaned
}

// mergeTasksServerSide reconciles the frontend-submitted task list with the
// server's current task list to prevent race conditions between webhook-created
// tasks and the frontend's periodic PUT /api/workspace calls.
//
// Rules:
//   - Tasks present in both lists: user-owned fields come from the incoming list,
//     server-managed fields (execution state, workflow progress, report) are kept
//     from the server's current copy.
//   - Tasks only in the incoming list (new tasks created by the frontend): kept as-is.
//   - Tasks only on the server: preserved ONLY if currently executing (active).
//     queued/completed server-only tasks are dropped — the frontend intentionally
//     removed them (board reset, manual delete, etc.).
func mergeTasksServerSide(serverTasks, incomingTasks []workspaceTask) []workspaceTask {
	serverMap := make(map[string]workspaceTask, len(serverTasks))
	for _, t := range serverTasks {
		serverMap[t.ID] = t
	}
	incomingIDs := make(map[string]struct{}, len(incomingTasks))
	for _, t := range incomingTasks {
		incomingIDs[t.ID] = struct{}{}
	}

	// Merge tasks known to the frontend: preserve server-managed fields
	merged := make([]workspaceTask, 0, len(incomingTasks))
	for _, inc := range incomingTasks {
		if srv, ok := serverMap[inc.ID]; ok {
			// executionStatus and startedAt are always server-authoritative
			inc.Execution = srv.Execution
			inc.StartedAt = srv.StartedAt
			// Workflow progress fields (step, context, reportId, status) are only
			// server-authoritative while a goroutine is actively running the task.
			// When the task is queued/completed, the frontend value wins — this lets
			// user-driven approve/reject actions advance the workflow without being
			// reverted by the next PUT merge.
			if srv.Execution == "active" || srv.Execution == "retrying" {
				inc.Status = srv.Status
				inc.WorkflowStep = srv.WorkflowStep
				inc.AccContext = srv.AccContext
				inc.ReportID = srv.ReportID
			}
		}
		merged = append(merged, inc)
	}

	// Preserve server-only tasks ONLY while their workflow goroutine is active.
	// This covers the brief race window between webhook ingest (task created) and
	// the frontend's next poll. Once the goroutine finishes or the task is queued,
	// the frontend's explicit state (including resets) takes precedence.
	for _, srv := range serverTasks {
		if _, known := incomingIDs[srv.ID]; !known {
			if srv.Execution == "active" || srv.Execution == "retrying" {
				merged = append([]workspaceTask{srv}, merged...)
			}
		}
	}

	return merged
}

// mergeBossReportsServerSide ensures boss reports created by server goroutines
// (webhook workflow completion) are not lost when the frontend sends a PUT.
// - Reports only on server: preserved (prepended so newest stays first)
// - Reports in both: incoming (user approval/rejection) wins
// - Reports only in incoming: kept (frontend-created)
func mergeBossReportsServerSide(serverReports, incomingReports []workspaceReport) []workspaceReport {
	incomingIDs := make(map[string]struct{}, len(incomingReports))
	for _, r := range incomingReports {
		incomingIDs[r.ID] = struct{}{}
	}

	// Prepend server-only reports that are still "new" (pending review).
	// Approved/rejected reports intentionally omitted by the client (e.g. clear-inbox)
	// must not be restored — only unreviewed reports can have been created by a race.
	var serverOnly []workspaceReport
	for _, r := range serverReports {
		if _, known := incomingIDs[r.ID]; !known && r.Status == "new" {
			serverOnly = append(serverOnly, r)
		}
	}
	return append(serverOnly, incomingReports...)
}

// mergeSessionsServerSide ensures session log entries written by server goroutines
// (webhook ingest, workflow steps) are not overwritten by frontend PUT.
// Sessions are append-only server logs — the frontend never creates them directly.
// Server-only entries are prepended to maintain newest-first order.
func mergeSessionsServerSide(serverSessions, incomingSessions []workspaceSessionLog) []workspaceSessionLog {
	incomingIDs := make(map[string]struct{}, len(incomingSessions))
	for _, s := range incomingSessions {
		incomingIDs[s.ID] = struct{}{}
	}

	var serverOnly []workspaceSessionLog
	for _, s := range serverSessions {
		if _, known := incomingIDs[s.ID]; !known {
			serverOnly = append(serverOnly, s)
		}
	}
	merged := append(serverOnly, incomingSessions...)
	// Cap at 30 entries (same limit as addSessionLog)
	if len(merged) > 30 {
		merged = merged[:30]
	}
	return merged
}

// addTask inserts a new task into the workspace (used by webhook ingest).
func (s *workspaceStore) addTask(task workspaceTask) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Tasks = append([]workspaceTask{task}, s.state.Tasks...)
	return s.saveLocked()
}

// addSessionLog prepends a session log entry (capped at 30 entries).
func (s *workspaceStore) addSessionLog(entry workspaceSessionLog) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Sessions = append([]workspaceSessionLog{entry}, s.state.Sessions...)
	if len(s.state.Sessions) > 30 {
		s.state.Sessions = s.state.Sessions[:30]
	}
	return s.saveLocked()
}

// as of the current API and will be rejected.
func isValidGeminiModel(model string) bool {
	if model == "" {
		return false
	}
	// Reject hallucinated/stale model strings that don't exist in Google's API.
	stale := []string{
		"gemini-3.0-flash-lite",
		"gemini-3-flash-preview",
		"gemini-3.1-flash-lite-preview",
		"gemini-3.1-flash-preview",
		"gemini-3.1-pro-preview",
	}
	for _, bad := range stale {
		if model == bad {
			return false
		}
	}
	return true
}
