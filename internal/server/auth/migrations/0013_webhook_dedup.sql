-- 0013_webhook_dedup.sql — webhook ingest idempotency.
--
-- alarming's durable outbox delivers at-least-once: a retry after a lost
-- 2xx response re-sends the same event with the same X-Delivery-Id header
-- (a UUID minted once per delivery row on the alarming side). Without
-- dedup, one slow response could spawn the same 5-step workflow twice and
-- burn LLM budget on a duplicate.
--
-- Each accepted delivery id is recorded here before processing; a second
-- arrival short-circuits with 200 {"status":"duplicate"} so the sender
-- marks the delivery done and stops retrying.
--
-- Rows are pruned after a retention window comfortably longer than the
-- sender's maximum retry span (~1h for alarming's 10-attempt/5-min-cap
-- backoff), so the table stays tiny.

CREATE TABLE IF NOT EXISTS webhook_seen_deliveries (
    delivery_id  TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    seen_at      INTEGER NOT NULL,           -- unix seconds
    PRIMARY KEY (delivery_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_seen_at
    ON webhook_seen_deliveries(seen_at);
