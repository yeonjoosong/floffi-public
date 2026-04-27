package server

// workspace_registry.go — Phase 11 lazy cache of per-workspace stores.
//
// Pre-Phase-11 the server held a single *workspaceStore as a Server
// field; every authenticated user shared its state. This file owns
// the replacement: a registry keyed by workspaceID that loads each
// workspace's row from SQLite on first touch and caches the live
// *workspaceStore in memory.
//
// Loading is lazy because boot-time eager load would scale poorly
// (thousands of workspaces × ~500 KB state_json), and because the
// 95% case is one user touching one or two workspaces at a time.
// The cache currently has no eviction — once loaded, a store stays
// in memory until the process exits. A future LRU is straightforward
// to drop in, but the current memory model (single binary, small
// install base) doesn't justify it yet.

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"floffi/internal/server/auth"
)

type workspaceRegistry struct {
	auth     *auth.Store
	onChange func(etag string) // fan-out to SSE subscribers when any workspace state changes

	mu     sync.Mutex
	stores map[string]*workspaceStore
}

// searchSyncFn returns the FTS5 rebuild callback wired into every
// store created by this registry. Pulled out so newWorkspaceStoreFromState
// and the lazy load path both wire the same function.
//
// Best-effort by design: errors are logged but never bubble back to the
// caller. A failed search index rebuild can't be allowed to block
// workspace persistence — the blob in workspaces.state_json is what's
// authoritative, the FTS5 table is derived and can always be rebuilt
// from scratch with a one-line admin script.
func (r *workspaceRegistry) searchSyncFn() func(string, workspaceState) {
	return func(workspaceID string, state workspaceState) {
		if workspaceID == "" {
			return
		}
		docs := stateToSearchDocs(state)
		if err := r.auth.ReplaceWorkspaceSearch(context.Background(), workspaceID, docs); err != nil {
			logger.Error("[search] workspace sync failed", "workspace", workspaceID, "err", err)
		}
	}
}

func newWorkspaceRegistry(authStore *auth.Store) *workspaceRegistry {
	return &workspaceRegistry{
		auth:   authStore,
		stores: map[string]*workspaceStore{},
	}
}

// For returns the workspaceStore for `workspaceID`. The store is
// constructed on the first request, hydrating its state from
// workspaces.state_json. Subsequent calls return the cached pointer
// so the in-memory state + ETag stay consistent across handlers.
//
// Returns auth.ErrWorkspaceNotFound when the row is missing or
// soft-deleted — handlers turn that into 404.
func (r *workspaceRegistry) For(ctx context.Context, workspaceID string) (*workspaceStore, error) {
	r.mu.Lock()
	if existing, ok := r.stores[workspaceID]; ok {
		r.mu.Unlock()
		return existing, nil
	}
	r.mu.Unlock()

	// Load outside the lock so concurrent first-touches for different
	// workspaces don't serialize on DB reads. Concurrent first-touches
	// for the SAME workspace can both reach this point and both attempt
	// to construct a store; we resolve the race below with a "winner
	// takes the cache slot" check.
	row, err := r.auth.FindWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	var state workspaceState
	if row.StateJSON != "" {
		if err := json.Unmarshal([]byte(row.StateJSON), &state); err != nil {
			return nil, fmt.Errorf("workspace %s: decode state: %w", workspaceID, err)
		}
	} else {
		state = defaultWorkspaceState()
	}
	// 단일 출처 reconcile: 사용자가 생성 다이얼로그에서 입력한 이름이
	// workspaces.name 으로는 들어갔지만 state_json.boardTitle 은 옛 default
	// ("Workspace") 로 저장돼 있을 수 있다. row.Name 을 권위 있는 값으로
	// 두고 boardTitle 을 거기에 맞춘다. newWorkspaceStoreFromState 가 호출
	// 하는 saveLocked 가 정정된 state 를 한 번 더 DB 에 써준다.
	if row.Name != "" && state.BoardTitle != row.Name {
		state.BoardTitle = row.Name
	}
	store, err := newWorkspaceStoreFromState(workspaceID, state, r.persistFn())
	if err != nil {
		return nil, err
	}
	store.onChange = r.onChange
	store.searchSync = r.searchSyncFn()
	// Newly hydrated stores have already saved once (inside
	// newWorkspaceStoreFromState) without searchSync wired. Trigger an
	// explicit sync here so the FTS5 index reflects current state right
	// after load, even if the user never mutates the workspace again.
	store.searchSync(workspaceID, store.snapshot())

	r.mu.Lock()
	if existing, ok := r.stores[workspaceID]; ok {
		// Race: another goroutine completed the load first. Discard our
		// duplicate and serve the winner — there's no harm in dropping
		// the loser store since neither has been published yet.
		r.mu.Unlock()
		return existing, nil
	}
	r.stores[workspaceID] = store
	r.mu.Unlock()
	return store, nil
}

// Forget drops a workspace from the in-memory cache. Used after delete
// or owner-transfer flows where the cached store's identity changed
// in the DB and stale memory would confuse subsequent reads.
func (r *workspaceRegistry) Forget(workspaceID string) {
	r.mu.Lock()
	delete(r.stores, workspaceID)
	r.mu.Unlock()
}

// CachedStores returns a snapshot of every store currently in the
// in-memory cache, paired with its workspaceID. Used by background
// workers (watchdog, retry scanner) that need to iterate every "live"
// workspace without re-reading the full DB list each tick.
//
// Tradeoff: a workspace that's never been touched since boot won't
// appear here, so its stuck tasks aren't recovered until someone
// loads it. Acceptable because (a) untouched workspaces shouldn't
// have active tasks in the first place, and (b) the first user
// access populates the cache so the next tick covers it.
func (r *workspaceRegistry) CachedStores() []struct {
	ID    string
	Store *workspaceStore
} {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]struct {
		ID    string
		Store *workspaceStore
	}, 0, len(r.stores))
	for id, st := range r.stores {
		out = append(out, struct {
			ID    string
			Store *workspaceStore
		}{ID: id, Store: st})
	}
	return out
}

// persistFn returns the writer that each store uses to flush its
// state to SQLite. Holding it as a method on the registry keeps the
// store struct from depending on *auth.Store directly.
func (r *workspaceRegistry) persistFn() func(string, string) error {
	return func(workspaceID, stateJSON string) error {
		return r.auth.UpdateWorkspaceState(context.Background(), workspaceID, stateJSON)
	}
}

// ImportState builds an in-memory workspaceStore around the given
// state without touching the cache. Used by the legacy
// .data/workspace.json importer to massage the state through
// normalize() before the row is written. The returned store is
// disconnected from the DB on purpose — callers serialize the final
// state themselves.
func ImportState(state workspaceState) *workspaceStore {
	return &workspaceStore{
		state: normalizeWorkspaceState(state),
	}
}
