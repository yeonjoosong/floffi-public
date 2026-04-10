package server

import (
	"context"
	"fmt"
	"time"

	"floffi/internal/server/auth"
)

const legacyBootstrapAdminEmail = "admin@clawork.local"

// ensureBootstrapAdminIntegrity repairs legacy auth DB states that would
// otherwise strand the instance without a reachable admin seat.
//
// Historical bad state we specifically recover from:
//   - a placeholder user with SuperAdminID + admin@clawork.local exists,
//     but is_admin=0 and no longer has a known credential.
//   - that stale row blocks the first real signup from becoming the
//     bootstrap admin, leaving the instance with zero admins.
//
// Recovery policy:
//  1. Delete the stale placeholder row when it exists.
//  2. If no admin remains but real users already exist, promote the
//     oldest remaining user to admin so the instance is operable.
func ensureBootstrapAdminIntegrity(authStore *auth.Store) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	rows, err := authStore.ListAllUsers(ctx)
	if err != nil {
		return fmt.Errorf("list users: %w", err)
	}
	for _, u := range rows {
		if u.ID == auth.SuperAdminID && u.Email == legacyBootstrapAdminEmail && !u.IsAdmin {
			if err := authStore.DeleteUserByID(ctx, u.ID); err != nil {
				return fmt.Errorf("delete legacy bootstrap placeholder: %w", err)
			}
			logger.Warn("auth bootstrap: removed stale legacy placeholder admin", "user", u.Email, "id", u.ID)
			rows, err = authStore.ListAllUsers(ctx)
			if err != nil {
				return fmt.Errorf("relist users: %w", err)
			}
			break
		}
	}

	for _, u := range rows {
		if u.IsAdmin {
			return nil
		}
	}
	if len(rows) == 0 {
		return nil
	}

	candidate := rows[len(rows)-1]
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].Email == legacyBootstrapAdminEmail {
			continue
		}
		candidate = rows[i]
		break
	}
	if candidate.Email == legacyBootstrapAdminEmail {
		return nil
	}
	if err := authStore.SetAdmin(ctx, candidate.ID, true); err != nil {
		return fmt.Errorf("promote bootstrap admin: %w", err)
	}
	logger.Warn("auth bootstrap: promoted existing user to recover admin access", "user", candidate.Email, "id", candidate.ID)
	return nil
}
