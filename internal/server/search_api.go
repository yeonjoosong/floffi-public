package server

import (
	"net/http"
	"strconv"
	"strings"
)

// search_api.go — Stage 1-A of plan/rag-and-memory-roadmap.md.
//
// GET /api/workspace/search?q=...&limit=20
//
// Searches the FTS5 index scoped to the request's active workspace.
// User-facing search ignores trust_score (callers see everything); the
// agent prompt path uses Store.SearchWorkspace directly with minTrust=0.7.
//
// Workspace isolation: resolveActiveWorkspace enforces membership + picks
// the active workspaceID. The FTS5 query also filters by workspace_id,
// so even a malformed resolver result can't leak rows across tenants.

func (s *Server) handleWorkspaceSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	ctx := s.resolveActiveWorkspace(w, r)
	if ctx == nil {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"hits": []any{}})
		return
	}
	// Sanitize for FTS5: callers pass plain phrases; we don't expose the
	// FTS5 query syntax (NEAR/AND/OR/column filters). Quote the whole
	// string so it's parsed as a literal phrase, escaping any embedded
	// double quotes per the FTS5 quoting rules.
	matchExpr := `"` + strings.ReplaceAll(q, `"`, `""`) + `"`

	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	hits, err := s.authStore.SearchWorkspace(r.Context(), ctx.workspace.ID, matchExpr, 0, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "search_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hits": hits})
}
