package server

import (
	"net/http"
	"strings"
)

// reports_api.go — Stage 1-B of plan/rag-and-memory-roadmap.md.
//
// POST /api/reports/{id}/approve   — workspace owner / report assignee 가
//                                    승인. trust_score = 1.0 → LLM inject 허용.
// POST /api/reports/{id}/demote    — 잘못된 리포트 표시. trust_score = 0.0.
// POST /api/reports/{id}/reset-trust — 승인 취소 (다시 0.5 자동값).
//
// 권한: 워크스페이스 owner 는 무조건 가능. 그 외 멤버는 본인이 리포트의
// AgentID 가 트리거한 태스크의 소유자/실행자일 때만 가능 — 현재 schema 는
// 실행자 user_id 를 따로 들고 있지 않아서 단계 1 에서는 "owner only" 로
// 단순화한다. 멤버 단위 승인이 필요해지면 별도 스키마 변경 + 권한 모델
// 확장을 검토.

func (s *Server) handleReportsSubtree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	ctx := s.resolveActiveWorkspace(w, r)
	if ctx == nil {
		return
	}
	// /api/reports/{id}/{verb}
	rest := strings.TrimPrefix(r.URL.Path, "/api/reports/")
	slash := strings.IndexByte(rest, '/')
	if slash <= 0 || slash == len(rest)-1 {
		http.NotFound(w, r)
		return
	}
	reportID := rest[:slash]
	verb := rest[slash+1:]

	// Stage-1 권한: owner 만 신뢰도를 바꿀 수 있다.
	if ctx.member == nil || ctx.member.Role != "owner" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "owner_only"})
		return
	}

	var (
		trust float64
		who   = ctx.user.ID
	)
	switch verb {
	case "approve":
		trust = 1.0
	case "demote":
		trust = 0.0
	case "reset-trust":
		trust = 0.5
		who = "" // clear ApprovedBy/At
	default:
		http.NotFound(w, r)
		return
	}

	if err := ctx.store.setReportTrust(reportID, trust, who); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "report_not_found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
