package server

import (
	"strings"
	"time"

	"floffi/internal/server/auth"
)

// workspace_search.go — Stage 1-A of plan/rag-and-memory-roadmap.md.
//
// Bridges the in-memory workspaceState into the FTS5 index rows owned by
// auth.Store. We index three source kinds:
//
//   * tasks   — title + description (+ accumulated workflow context)
//   * reports — title + summary, gated by trust_score for LLM inject
//   * vault   — title + note
//
// Soft-deleted tasks (deletedAt != "") are skipped — the index should match
// what the user can currently see in the UI.
//
// trust_score policy:
//   * tasks  → 0.5 (always user-visible, never auto-inject)
//   * vault  → 1.0 (user-authored docs are treated as trusted by default)
//   * reports→ whatever the report row says (default 0.5; approval flips to 1.0)

// stateToSearchDocs flattens a workspace state into the indexable rows the
// FTS5 layer expects. Pure function — no DB access, no goroutines — so
// callers can invoke it inside the saveLocked hot path without contention.
func stateToSearchDocs(state workspaceState) []auth.SearchDoc {
	docs := make([]auth.SearchDoc, 0, len(state.Tasks)+len(state.BossReports)+len(state.VaultDocs))

	for _, t := range state.Tasks {
		if t.DeletedAt != "" {
			continue
		}
		body := t.Description
		if t.AccContext != "" {
			// AccContext is workflow-accumulated text from prior steps.
			// Including it widens recall ("planner의 분석에 X 가 있었나?") and
			// matches what the user reads in the task detail panel.
			body = body + "\n\n" + t.AccContext
		}
		docs = append(docs, auth.SearchDoc{
			SourceType: "task",
			SourceID:   t.ID,
			TrustScore: 0.5, // user-visible but blocked from LLM inject
			UpdatedAt:  parseRFC3339Unix(t.Date, t.CreatedAt),
			Title:      strings.TrimSpace(t.Title),
			Body:       strings.TrimSpace(body),
		})
	}

	for _, r := range state.BossReports {
		score := r.TrustScore
		if score == 0 && r.ApprovedAt == "" {
			// Defensive fallback for ancient rows that slipped past normalize.
			score = 0.5
		}
		docs = append(docs, auth.SearchDoc{
			SourceType: "report",
			SourceID:   r.ID,
			TrustScore: score,
			UpdatedAt:  parseRFC3339Unix(r.DeliveredAt, ""),
			Title:      strings.TrimSpace(r.Title),
			Body:       strings.TrimSpace(r.Summary),
		})
	}

	for _, v := range state.VaultDocs {
		docs = append(docs, auth.SearchDoc{
			SourceType: "vault",
			SourceID:   v.ID,
			TrustScore: 1.0, // user-authored docs treated as trusted
			UpdatedAt:  time.Now().Unix(), // vault docs don't carry timestamps in state today
			Title:      strings.TrimSpace(v.Title),
			Body:       strings.TrimSpace(v.Note),
		})
	}

	return docs
}

// parseRFC3339Unix parses an RFC3339 string; on failure it falls back to
// the secondary string (also tried as RFC3339), else returns 0. workspaceTask
// stores both Date + CreatedAt as RFC3339 strings — using whichever is non-
// empty keeps the FTS row's updated_at column meaningful for "stale" filters
// without forcing a schema change.
func parseRFC3339Unix(primary, fallback string) int64 {
	for _, s := range []string{primary, fallback} {
		if s == "" {
			continue
		}
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t.Unix()
		}
	}
	return 0
}
