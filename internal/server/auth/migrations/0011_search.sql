-- 0011_search.sql — Stage 1-A of plan/rag-and-memory-roadmap.md.
--
-- FTS5 keyword index over per-workspace content. Three design points:
--
--   1. The blob in workspaces.state_json stays authoritative. This table is
--      a derived index, push-synced from Go whenever workspaceStore.saveLocked
--      runs. SQLite triggers on JSON1 paths are awkward; the Go funnel is the
--      right place.
--
--   2. trust_score lives on the row so the LLM-inject path can filter
--      without a join. User-facing search ignores trust_score (all indexed
--      rows visible); the prompt-injection path applies `trust_score >= 0.7`.
--      This is "옵션 C": index everything, gate the inject.
--
--   3. tokenize=unicode61 + remove_diacritics keeps Korean / mixed Korean+
--      English working. CJK ideographs become their own tokens; for queries
--      like "결제 실패" this is plenty without an external tokenizer.

CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search USING fts5(
    workspace_id  UNINDEXED,
    source_type   UNINDEXED,        -- 'task' | 'report' | 'vault'
    source_id     UNINDEXED,
    trust_score   UNINDEXED,        -- TEXT: '0.0' / '0.5' / '1.0'
    updated_at    UNINDEXED,        -- unix seconds; lets the LLM filter stale rows
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);
