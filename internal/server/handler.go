package server

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"floffi/internal/server/auth"
)

//go:embed web/dist
var webFS embed.FS

//go:embed web/static
var staticFS embed.FS

var (
	distFS       fs.FS
	assetVersion string
)

func init() {
	var err error
	distFS, err = fs.Sub(webFS, "web/dist")
	if err != nil {
		panic(err)
	}
	// Compute a content-hash version string for cache-busting.
	h := sha256.New()
	for _, p := range []string{"assets/app.js", "assets/app.css"} {
		if data, err := fs.ReadFile(distFS, p); err == nil {
			h.Write(data)
		}
	}
	assetVersion = hex.EncodeToString(h.Sum(nil))[:10]
}

func NewHandler() http.Handler {
	return newHandlerWithAuth(DefaultAuthConfig())
}

func newHandlerWithAuth(ac AuthConfig) http.Handler {
	root, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	if err := ensureDataDir(); err != nil {
		panic(err)
	}

	// Use an in-process SQLite file under the project root so tests pick up
	// the same .data/ directory the server uses. Tests can override the
	// working dir with t.TempDir() + os.Chdir if they need isolation.
	authStore, err := auth.Open(filepath.Join(root, ".data", "auth.db"))
	if err != nil {
		panic(err)
	}
	authHandler := auth.NewHandler(authStore)
	if err := ensureBootstrapAdminIntegrity(authStore); err != nil {
		panic(err)
	}

	registry, workspace, defaultID, err := bootstrapWorkspaces(authStore)
	if err != nil {
		panic(err)
	}

	s := &Server{
		auth:               ac.withDefaults(),
		authStore:          authStore,
		authHandler:        authHandler,
		workspaces:         registry,
		workspace:          workspace,
		defaultWorkspaceID: defaultID,
		limiter:            newLLMRateLimiter(),
		quota:              newDailyQuota(),
		sseSubs:            map[chan string]string{},
	}
	registry.onChange = s.publishWorkspaceChanged
	if workspace != nil {
		workspace.onChange = s.publishWorkspaceChanged
	}
	// Wire the auth handler's revoke callback to the SSE broadcaster
	// so single_session kicks land on the affected user's live stream
	// in the same tick the new login completes (0s latency).
	authHandler.OnSessionRevoked = s.notifyUserSessionRevoked
	authHandler.OnUserSignedUp = s.provisionDefaultWorkspaceForUser
	return s.newHandler()
}

func (s *Server) newHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRoot)
	mux.HandleFunc("/login", s.handleLoginPage)
	// 워크스페이스 초대 링크. 인증 여부와 무관하게 SPA 셸을 그대로
	// 서빙해서 프론트(InviteAcceptView) 가 토큰을 처리하게 한다. 미인증
	// 사용자라면 셸이 LoginView 를 보여주고, 그 동안 토큰은 sessionStorage
	// 에 보존돼 로그인 직후 자동 복원된다.
	mux.HandleFunc("/invite", s.handleInvitePage)
	// Legacy username+HMAC auth — kept as compat for any client still
	// hitting these paths. Phase 1+2 ships the new /api/auth/* tree.
	mux.HandleFunc("/api/login", s.handleAPILogin)
	mux.HandleFunc("/api/logout", s.handleAPILogout)
	mux.HandleFunc("/api/session", s.handleSession)
	// New SQLite-backed auth (signup + login + JWT cookies + refresh rotation).
	if s.authHandler != nil {
		s.authHandler.Mount(mux)
	}
	mux.HandleFunc("/api/workspace", s.handleWorkspace)
	mux.HandleFunc("/api/workspace/stream", s.handleWorkspaceStream)
	// Phase 11 multi-workspace surface — list/create on the collection
	// path, all per-workspace verbs (rename, delete, members, invite,
	// transfer, mode-personal) on the subtree.
	mux.HandleFunc("/api/workspaces", s.handleWorkspacesRoot)
	mux.HandleFunc("/api/workspaces/", s.handleWorkspacesSubtree)
	mux.HandleFunc("/api/vault/search", s.handleVaultSearch)
	// Stage 1-A: workspace-scoped FTS5 search (tasks / reports / vault).
	mux.HandleFunc("/api/workspace/search", s.handleWorkspaceSearch)
	// Stage 1-B: approve / demote a boss report to gate LLM inject.
	mux.HandleFunc("/api/reports/", s.handleReportsSubtree)
	mux.HandleFunc("/api/tasks/", s.handleTaskDispatch)
	mux.HandleFunc("/api/playground", s.handlePlayground)
	mux.HandleFunc("/api/webhooks/", s.handleWebhookIngest)
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/assets/", s.handleAsset)
	mux.HandleFunc("/themes/", s.handleAsset)
	mux.HandleFunc("/favicon.ico", s.handleStaticFile)
	mux.HandleFunc("/favicon.svg", s.handleStaticFile)
	mux.HandleFunc("/favicon-16.png", s.handleStaticFile)
	mux.HandleFunc("/favicon-32.png", s.handleStaticFile)
	mux.HandleFunc("/favicon-48.png", s.handleStaticFile)
	mux.HandleFunc("/favicon-180.png", s.handleStaticFile)
	mux.HandleFunc("/favicon-192.png", s.handleStaticFile)
	mux.HandleFunc("/favicon-512.png", s.handleStaticFile)
	mux.HandleFunc("/readme-preview.html", s.handleStaticFile)
	mux.HandleFunc("/readme-preview-assets/", s.handleStaticFile)
	// withDevUIProxy MUST be outermost: the HMR websocket upgrade needs the
	// raw ResponseWriter (http.Hijacker), and requestLogger's statusRecorder
	// wrapper would hide it. UI requests in dev skip the logger entirely
	// (they're Vite noise anyway); API requests still flow through it.
	return withDevUIProxy(withRequestID(requestLogger(withBYOKKey(mux))))
}

// withDevUIProxy reverse-proxies UI requests to the Vite dev server when
// FLOFFI_DEV_UI is set (start.sh --dev exports it). This keeps the familiar
// backend port serving the LIVE frontend with HMR instead of the stale bundle
// embedded at `go build` time — without it, hitting the backend port in dev
// silently shows old UI. API and health routes still go to the real handlers;
// everything else (pages, assets, the HMR websocket at "/") is forwarded.
// httputil.ReverseProxy passes WebSocket upgrades through, so Vite HMR works.
// Unset (production / tests) this is a no-op.
func withDevUIProxy(next http.Handler) http.Handler {
	target := os.Getenv("FLOFFI_DEV_UI")
	if target == "" {
		return next
	}
	u, err := url.Parse(target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  FLOFFI_DEV_UI invalid (%q): %v — serving embedded UI\n", target, err)
		return next
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	fmt.Fprintf(os.Stderr, "  DEV UI proxy: non-API requests → %s (Vite HMR)\n", target)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

// withBYOKKey threads any X-LLM-Key request header into the context so the
// downstream LLM call functions can prefer the user's key over the server's
// env-var fallback. The header is consumed and never logged or echoed.
func withBYOKKey(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-LLM-Key")
		if key != "" {
			ctx := withLLMKey(r.Context(), key)
			r = r.WithContext(ctx)
			// Strip from headers so it can't be reflected by any later handler.
			r.Header.Del("X-LLM-Key")
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the response status so the request logger can print it.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// requestLogger prints one line per HTTP request: timestamp, method, path,
// status, and duration. Static assets (/assets/) and the health probe are
// kept quiet to avoid drowning out the interesting traffic.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		quiet := strings.HasPrefix(r.URL.Path, "/assets/") ||
			strings.HasPrefix(r.URL.Path, "/themes/") ||
			r.URL.Path == "/healthz" ||
			r.URL.Path == "/api/workspace/stream"
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if !quiet {
			logger.Info("http",
				"request_id", requestIDFrom(r.Context()),
				"status", rec.status,
				"method", r.Method,
				"path", r.URL.Path,
				"dur", time.Since(start).Round(time.Millisecond).String())
		}
	})
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	if !s.authed(r) {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}

	s.serveAppShell(w, r)
}

// securityHeadersForHTML applies the baseline browser security headers to any
// response that delivers an HTML document. Kept narrow on purpose: same-origin
// scripts/connect, no inline scripts, no framing. Style and image rules are
// loose enough to support the inline loader styles + markdown-rendered images.
func securityHeadersForHTML(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; "+
			"script-src 'self'; "+
			"style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data: blob: https:; "+
			"font-src 'self' data:; "+
			"connect-src 'self'; "+
			"frame-ancestors 'none'; "+
			"base-uri 'self'; "+
			"form-action 'self'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "same-origin")
	// HSTS is harmless on plain HTTP (browsers ignore it); on HTTPS it locks
	// future visits to TLS, defending against the first-visit downgrade window.
	w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
}

func (s *Server) serveAppShell(w http.ResponseWriter, r *http.Request) {
	securityHeadersForHTML(w)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <link rel="icon" href="/favicon.ico?v=%s" sizes="any" />
    <link rel="apple-touch-icon" href="/favicon-180.png?v=%s" />
    <meta name="theme-color" content="#ff8a1d" />
    <title>floffi</title>
    <script type="module" crossorigin src="/assets/app.js?v=%s"></script>
    <link rel="stylesheet" crossorigin href="/assets/app.css?v=%s" />
  </head>`, assetVersion, assetVersion, assetVersion, assetVersion)
	_, _ = fmt.Fprint(w, `
  <body>
    <div id="root">
      <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff9d6;color:#5c4210;font-family:Verdana,'Noto Sans KR',sans-serif;font-weight:700;padding:24px;text-align:center;">
        <div style="max-width:640px;background:#ffffff;border-radius:28px;padding:32px;box-shadow:0 18px 32px rgba(242,182,73,0.18);">
          floffi 화면을 불러오는 중입니다.
        </div>
      </main>
    </div>
  </body>
</html>`)
}

// handleStaticFile serves files embedded from web/static (favicon and friends)
// at top-level URL paths like /favicon.ico, /favicon.svg, /favicon-180.png.
func (s *Server) handleStaticFile(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	data, err := fs.ReadFile(staticFS, "web/static/"+name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	assetPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	// /assets/* is the Vite bundle output; /themes/* is anything the
	// frontend dropped into public/themes/ (per-theme image assets like
	// the toy section icons). Both end up under web/dist/ at build time.
	if !strings.HasPrefix(assetPath, "assets/") && !strings.HasPrefix(assetPath, "themes/") {
		http.NotFound(w, r)
		return
	}

	file, err := distFS.Open(assetPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	body, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "failed to read asset", http.StatusInternalServerError)
		return
	}

	if contentType := mime.TypeByExtension(path.Ext(assetPath)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}
