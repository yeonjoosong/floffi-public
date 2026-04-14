package auth

// ratelimit.go — tiny in-memory sliding-window limiter.
//
// We keep this in-process on purpose: floffi is a single-binary Go server
// with SQLite, and a "distributed" limiter (Redis, etc.) would add a hard
// dependency for negligible benefit. If the process restarts mid-attack
// the counters reset; that's acceptable because the next request still
// has to pass argon2id verification (~100ms each), so per-IP brute force
// is naturally throttled even without us.
//
// Memory cost is bounded by the GC pruning loop — see Handler.gcLoop.

import (
	"sync"
	"time"
)

// RateLimiter is a sliding-window limiter keyed by an arbitrary string.
// Implementation note: we store a slice of timestamps per key, pruned on
// every call. O(n) per check where n is "events still inside the window";
// fine for our scale (under a thousand auth attempts/sec across the whole
// instance would be a remarkable workload here).
type RateLimiter struct {
	window time.Duration
	max    int
	mu     sync.Mutex
	keys   map[string][]time.Time
}

func NewRateLimiter(window time.Duration, max int) *RateLimiter {
	return &RateLimiter{
		window: window,
		max:    max,
		keys:   make(map[string][]time.Time),
	}
}

// Allow records an event for key and returns false if the key has met or
// exceeded max events within the trailing window. The blocked attempt is
// still recorded — this is intentional. Without it, an attacker who keeps
// hammering past the limit could keep the window perpetually full, but a
// well-behaved client who just hit the cap would also stay blocked even
// after the window slid past their old events. Counting the block keeps
// the attacker's window slid forward by their own traffic, which is the
// behavior we want (steady-state throttle, not lockout-on-burst).
func (rl *RateLimiter) Allow(key string) bool {
	now := time.Now()
	cutoff := now.Add(-rl.window)
	rl.mu.Lock()
	defer rl.mu.Unlock()
	stamps := rl.keys[key]
	keep := stamps[:0]
	for _, t := range stamps {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	if len(keep) >= rl.max {
		// Record the blocked attempt too so the window doesn't reset
		// the moment the attacker pauses — see comment on the function.
		keep = append(keep, now)
		rl.keys[key] = keep
		return false
	}
	keep = append(keep, now)
	rl.keys[key] = keep
	return true
}

// Blocked reports whether key has met or exceeded max events within the
// trailing window WITHOUT recording a new event. Pair with Record() for
// flows where only certain outcomes (e.g. failed logins) should count.
func (rl *RateLimiter) Blocked(key string) bool {
	cutoff := time.Now().Add(-rl.window)
	rl.mu.Lock()
	defer rl.mu.Unlock()
	stamps := rl.keys[key]
	keep := stamps[:0]
	for _, t := range stamps {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	rl.keys[key] = keep
	return len(keep) >= rl.max
}

// Record adds a timestamp for key WITHOUT checking the cap. Returns the
// number of events now in the trailing window. Use with Blocked() when
// the call site needs to count failures but allow the failing call
// itself to complete (the user gets one chance to see "wrong password"
// before being throttled out of the next attempt).
func (rl *RateLimiter) Record(key string) int {
	now := time.Now()
	cutoff := now.Add(-rl.window)
	rl.mu.Lock()
	defer rl.mu.Unlock()
	stamps := rl.keys[key]
	keep := stamps[:0]
	for _, t := range stamps {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	keep = append(keep, now)
	rl.keys[key] = keep
	return len(keep)
}

// Reset wipes the key's counter. Call on successful login to give an
// authenticated user a clean slate — they shouldn't pay for prior
// failures once they've proven the password.
func (rl *RateLimiter) Reset(key string) {
	rl.mu.Lock()
	delete(rl.keys, key)
	rl.mu.Unlock()
}

// GC prunes stale entries across all keys and drops empty keys entirely.
// Called periodically (see Handler.startGC) so the map can't grow without
// bound under sustained low-rate abuse from many distinct IPs.
func (rl *RateLimiter) GC() {
	cutoff := time.Now().Add(-rl.window)
	rl.mu.Lock()
	defer rl.mu.Unlock()
	for k, stamps := range rl.keys {
		keep := stamps[:0]
		for _, t := range stamps {
			if t.After(cutoff) {
				keep = append(keep, t)
			}
		}
		if len(keep) == 0 {
			delete(rl.keys, k)
		} else {
			rl.keys[k] = keep
		}
	}
}

// Size returns the number of tracked keys. Used by tests to assert GC
// actually cleaned up.
func (rl *RateLimiter) Size() int {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	return len(rl.keys)
}
