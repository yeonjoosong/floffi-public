package server

// Structured logging foundation.
//
// Before this, the server logged via bare fmt.Printf, so production logs had
// no levels, no machine-parseable fields, and no way to correlate the lines
// belonging to one HTTP request. This file introduces:
//
//   - a package-level slog.Logger (JSON in prod, human text in dev),
//   - a per-request ID injected into context + echoed as X-Request-Id,
//   - helpers so handlers/workers can log with the request ID attached.
//
// The startup banner in server.go stays on fmt.Println on purpose — it's
// deliberate box-drawing meant for a human reading the console, not a log
// stream.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"os"
)

// logger is the process-wide structured logger. Prod (FLOFFI_PROD=1) emits
// JSON for log shippers; dev emits readable text.
var logger = newLogger()

func newLogger() *slog.Logger {
	opts := &slog.HandlerOptions{Level: slog.LevelInfo}
	if os.Getenv("FLOFFI_PROD") == "1" {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, opts))
}

type ctxKey int

const requestIDKey ctxKey = iota

// newRequestID returns a short random hex token. Collisions don't matter for
// correlation, so 8 bytes is plenty; crypto/rand avoids the banned
// Math.random equivalents and needs no seeding.
func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(b[:])
}

// requestIDFrom pulls the request ID out of a context, or "" if absent.
func requestIDFrom(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

// withRequestID assigns each request an ID, stores it in the request context
// (so downstream handlers/workers can attach it to their logs), and echoes it
// in the X-Request-Id response header for client-side correlation.
func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := newRequestID()
		w.Header().Set("X-Request-Id", id)
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
