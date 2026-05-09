package auth

import (
	"context"
	"time"
)

// webhookSeenRetention is how long an accepted delivery id is remembered.
// It only needs to outlive the sender's retry window (alarming's outbox
// gives up after ~10 attempts with a 5-minute backoff cap, i.e. well under
// an hour); 24h leaves a wide margin without letting the table grow.
const webhookSeenRetention = 24 * time.Hour

// MarkWebhookDeliverySeen records a webhook delivery id for a workspace and
// reports whether this is the first time it was seen. The insert-first order
// makes processing at-most-once on the floffi side: the row is written
// before any workflow is spawned, so a concurrent or later retry of the same
// delivery short-circuits even if the first request is still in flight.
//
// Expired rows (older than webhookSeenRetention) are pruned opportunistically
// on each call — the table is tiny (one row per accepted delivery) so the
// DELETE is cheap and saves a dedicated janitor goroutine.
func (s *Store) MarkWebhookDeliverySeen(ctx context.Context, workspaceID, deliveryID string) (bool, error) {
	now := time.Now().Unix()

	cutoff := now - int64(webhookSeenRetention/time.Second)
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM webhook_seen_deliveries WHERE seen_at < ?`, cutoff); err != nil {
		return false, err
	}

	res, err := s.db.ExecContext(ctx,
		`INSERT INTO webhook_seen_deliveries (delivery_id, workspace_id, seen_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT (delivery_id, workspace_id) DO NOTHING`,
		deliveryID, workspaceID, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}
