import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev mode (`./start.sh --dev` → `vite`): the UI is served by Vite with HMR,
// and API/SSE calls are proxied to the Go backend. start.sh exports
// FLOFFI_BACKEND_PORT so the proxy follows whatever --port was given.
// changeOrigin is intentionally OFF so the backend sees the Vite host and
// any absolute URLs it builds (e.g. invite links) point back at the dev UI.
const backend = `http://localhost:${process.env.FLOFFI_BACKEND_PORT ?? "8081"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    // localhost 전용 바인딩 — UI 는 Go 서버(백엔드 포트)가 프록시로
    // 서빙하므로 Vite 포트(백엔드+1)를 외부에 노출할 이유가 없다.
    // 원격 접속도 Go 포트 하나로 충분하다.
    host: "127.0.0.1",
    proxy: {
      "/api": { target: backend }, // SSE(/api/workspace/stream) 포함
      "/healthz": { target: backend },
    },
  },
  build: {
    outDir: "../internal/server/web/dist",
    emptyOutDir: true,
    // We intentionally ship a single app.js (entryFileNames below pins it),
    // so manualChunks/code-splitting isn't applicable here. Raise the warning
    // ceiling above the current bundle size to silence the chunk-size notice.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/chunk-[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) {
            return "assets/app.css";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
