package auth

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
)

// FTS5 sync + query helpers (Stage 1-A of plan/rag-and-memory-roadmap.md).
//
// The workspace store funnels every state change through saveLocked(), and
// that's where ReplaceWorkspaceSearch is called from. We delete and reinsert
// the workspace's rows in one transaction — workspace state blobs are small
// enough (typically <100 rows) that a full rebuild is simpler and safer than
// per-row deltas, and the resulting tx is still sub-millisecond on a warm DB.

// SearchDoc is one indexable row pushed into FTS5. Title + Body are searched;
// the rest are UNINDEXED metadata.
type SearchDoc struct {
	SourceType string  // 'task' | 'report' | 'vault'
	SourceID   string
	TrustScore float64 // 0..1
	UpdatedAt  int64   // unix seconds
	Title      string
	Body       string
}

// ReplaceWorkspaceSearch atomically replaces every FTS5 row for the given
// workspace. Pass docs == nil to clear (workspace was deleted).
//
// Performance: ~30µs per row on warm WAL; a typical workspace (50 docs)
// rebuilds in ~2 ms, which is comfortably inside the saveLocked path.
func (s *Store) ReplaceWorkspaceSearch(ctx context.Context, workspaceID string, docs []SearchDoc) error {
	if workspaceID == "" {
		return fmt.Errorf("search sync: empty workspaceID")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("search sync: begin: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM workspace_search WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("search sync: delete: %w", err)
	}
	if len(docs) > 0 {
		stmt, err := tx.PrepareContext(ctx, `
			INSERT INTO workspace_search
			  (workspace_id, source_type, source_id, trust_score, updated_at, title, body)
			VALUES (?, ?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return fmt.Errorf("search sync: prepare: %w", err)
		}
		defer stmt.Close()
		for _, d := range docs {
			if _, err := stmt.ExecContext(ctx,
				workspaceID,
				d.SourceType,
				d.SourceID,
				strconv.FormatFloat(d.TrustScore, 'f', 1, 64),
				strconv.FormatInt(d.UpdatedAt, 10),
				d.Title,
				d.Body,
			); err != nil {
				return fmt.Errorf("search sync: insert: %w", err)
			}
		}
	}
	return tx.Commit()
}

// DeleteWorkspaceSearch wipes every FTS5 row for a workspace. Called from
// the workspace soft-delete path (and tests).
func (s *Store) DeleteWorkspaceSearch(ctx context.Context, workspaceID string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM workspace_search WHERE workspace_id = ?`, workspaceID)
	return err
}

// SearchHit is one row coming back from a query. Score is the FTS5 bm25
// rank (lower = closer); the caller usually only needs ordering, not the
// raw value.
type SearchHit struct {
	SourceType string  `json:"sourceType"`
	SourceID   string  `json:"sourceId"`
	Title      string  `json:"title"`
	Snippet    string  `json:"snippet"`
	TrustScore float64 `json:"trustScore"`
	UpdatedAt  int64   `json:"updatedAt"`
	Score      float64 `json:"score"`
}

// SearchWorkspace runs an FTS5 MATCH query scoped to one workspace. When
// minTrust > 0 the LLM-inject path can filter out unapproved rows
// (옵션 C). User-facing searches pass minTrust=0 to see everything.
//
// limit is hard-capped at 50 — callers ask for what they need; the cap
// is a safety net for runaway queries.
func (s *Store) SearchWorkspace(ctx context.Context, workspaceID, query string, minTrust float64, limit int) ([]SearchHit, error) {
	if workspaceID == "" || query == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	// minTrust must be enforced in SQL (not only in the row scan) so it
	// applies BEFORE the LIMIT. Otherwise a flood of low-trust rows (e.g.
	// many alarm tasks at trust 0.5 that all share the query terms) can fill
	// the top-N by bm25 and push a high-trust runbook (1.0) out of the
	// window — the scan-time filter then drops everything and RAG inject
	// silently returns nothing. trust_score is stored as TEXT, hence CAST.
	rows, err := s.db.QueryContext(ctx, `
		SELECT source_type, source_id, title,
		       snippet(workspace_search, 6, '<b>', '</b>', ' … ', 16) AS snip,
		       trust_score, updated_at, bm25(workspace_search) AS score
		FROM workspace_search
		WHERE workspace_id = ?
		  AND workspace_search MATCH ?
		  AND CAST(trust_score AS REAL) >= ?
		ORDER BY score
		LIMIT ?`,
		workspaceID, query, minTrust, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSearchHits(rows, minTrust)
}

func scanSearchHits(rows *sql.Rows, minTrust float64) ([]SearchHit, error) {
	out := []SearchHit{}
	for rows.Next() {
		var (
			h          SearchHit
			trustStr   string
			updatedStr string
		)
		if err := rows.Scan(&h.SourceType, &h.SourceID, &h.Title, &h.Snippet,
			&trustStr, &updatedStr, &h.Score); err != nil {
			return nil, err
		}
		if v, err := strconv.ParseFloat(trustStr, 64); err == nil {
			h.TrustScore = v
		}
		if v, err := strconv.ParseInt(updatedStr, 10, 64); err == nil {
			h.UpdatedAt = v
		}
		if h.TrustScore < minTrust {
			continue
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
