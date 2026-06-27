#!/usr/bin/env bash
set -e

export PATH="$PATH:/usr/local/go/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT=8081
ENV_FILE=""
DEV=0
while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--port) PORT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --dev) DEV=1; shift ;;
    *) echo "Unknown option: $1"; echo "Usage: $0 [--port PORT] [--env-file FILE] [--dev]"; exit 1 ;;
  esac
done

# env-file 결정: 플래그 > 기본 .env
if [ -n "$ENV_FILE" ]; then
  DOTENV_OPT="--env-file $ENV_FILE"
elif [ -f ".env" ]; then
  echo "  .env file found, loading..."
  DOTENV_OPT="--env-file .env"
else
  DOTENV_OPT=""
fi

# 기존 floffi 프로세스가 있으면 종료
free_port() {
  local EXISTING_PID
  EXISTING_PID=$(lsof -ti:$PORT -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -n "$EXISTING_PID" ]; then
    local EXISTING_CMD
    EXISTING_CMD=$(ps -p "$EXISTING_PID" -o comm= 2>/dev/null || echo "unknown")
    if [ "$EXISTING_CMD" = "floffi" ]; then
      echo "  Stopping existing floffi (PID $EXISTING_PID)..."
      kill "$EXISTING_PID"
      sleep 1
    else
      echo "  ERROR: port $PORT is already in use by '$EXISTING_CMD' (PID $EXISTING_PID)"
      echo "  Change the port with: ./start.sh --port 9090"
      exit 1
    fi
  fi
}

# ──────────────────────────────────────────────────────────────────────
# DEV 모드: 재시작 없이 변경 사항 즉시 반영
#  - 프론트엔드: Vite dev 서버(HMR) — 저장하면 브라우저에 바로 반영
#  - 백엔드: *.go / go.mod / go.sum 변경 감지 → 자동 재빌드 + 재시작
#  UI는 Vite 포트(기본 5173)로 접속하고, /api·/healthz 는 Go 백엔드로
#  프록시된다 (frontend/vite.config.ts 참고).
# ──────────────────────────────────────────────────────────────────────
if [ "$DEV" = "1" ]; then
  echo "=== DEV mode: hot reload ==="

  if [ ! -d frontend/node_modules ]; then
    echo "--- npm install (first run) ---"
    (cd frontend && npm install)
  fi

  # embed 대상(web/dist)이 비어 있으면 go build 가 실패하므로 한 번 채워둔다
  if [ ! -f internal/server/web/dist/index.html ]; then
    echo "--- initial frontend build (embed seed) ---"
    (cd frontend && npm run build)
  fi

  free_port

  GO_PID=""
  VITE_PID=""
  cleanup() {
    [ -n "$GO_PID" ] && kill "$GO_PID" 2>/dev/null
    [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
    rm -f .dev-stamp
  }
  trap cleanup EXIT INT TERM

  # Vite 포트: 백엔드 포트+1 부터 비어 있는 포트를 탐색한다. 5173 고정은
  # 다른 프로젝트의 vite 가 이미 5173 을 쓰고 있을 때 floffi vite 가
  # 죽고(--strictPort), Go 프록시는 엉뚱한 앱(5173)으로 UI 를 포워딩하는
  # 사고가 났다. 백엔드 포트에서 파생시키면 프로젝트끼리 충돌하지 않는다.
  VITE_PORT=$((PORT + 1))
  while lsof -ti:$VITE_PORT -sTCP:LISTEN >/dev/null 2>&1; do
    VITE_PORT=$((VITE_PORT + 1))
  done

  echo "--- Vite dev server (HMR, port $VITE_PORT) ---"
  (cd frontend && FLOFFI_BACKEND_PORT="$PORT" npm run dev -- --strictPort --port "$VITE_PORT") &
  VITE_PID=$!

  # Vite 가 실제로 리슨할 때까지 대기 — 기동 실패(포트 경합 등)를 조용히
  # 지나치면 프록시가 죽은 포트(또는 남의 앱)로 향한다. 실패 시 즉시 중단.
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "http://localhost:$VITE_PORT/"; then
      break
    fi
    if ! kill -0 "$VITE_PID" 2>/dev/null; then
      echo "[fail] Vite dev server 기동 실패 — 위 로그를 확인하세요"
      exit 1
    fi
    sleep 0.5
  done
  if ! curl -sf -o /dev/null "http://localhost:$VITE_PORT/"; then
    echo "[fail] Vite dev server 가 20초 내에 응답하지 않습니다 (port $VITE_PORT)"
    exit 1
  fi

  start_go() {
    # FLOFFI_DEV_UI: Go 서버가 UI 요청을 Vite 로 프록시 → 평소 쓰던
    # 백엔드 포트로 접속해도 최신 UI(HMR)가 보인다 (handler.go 참고).
    FLOFFI_ALLOW_DEV_BIND="${FLOFFI_ALLOW_DEV_BIND:-1}" FLOFFI_DEV_UI="http://localhost:$VITE_PORT" ./floffi serve --port "$PORT" $DOTENV_OPT &
    GO_PID=$!
  }

  echo "--- Go build ---"
  go build -o floffi ./cmd/floffi
  touch .dev-stamp
  start_go

  echo
  echo "dev UI  : http://localhost:$PORT  (평소 포트 그대로 — HMR 즉시 반영)"
  echo "backend : http://localhost:$PORT/api (Go 변경 시 자동 재시작)"
  echo "vite    : 127.0.0.1:$VITE_PORT (내부 전용 — 직접 접속할 필요 없음)"
  echo

  # 외부 워처 의존성 없이 폴링으로 Go 소스 변경 감지
  while true; do
    sleep 1
    CHANGED=$(find cmd internal go.mod go.sum \
      \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' -o -name '*.sql' \) \
      -newer .dev-stamp -print -quit 2>/dev/null)
    if [ -n "$CHANGED" ]; then
      touch .dev-stamp
      echo "[reload] change detected: $CHANGED — rebuilding..."
      if go build -o floffi ./cmd/floffi; then
        kill "$GO_PID" 2>/dev/null || true
        wait "$GO_PID" 2>/dev/null || true
        start_go
        echo "[ok] backend restarted (PID $GO_PID)"
      else
        echo "[fail] build failed — 기존 서버 유지, 수정 후 자동 재시도됩니다"
      fi
    fi
  done
fi

# ──────────────────────────────────────────────────────────────────────
# 일반(프로덕션) 모드
# ──────────────────────────────────────────────────────────────────────
echo "=== [1/3] Frontend build ==="
cd frontend
npm install
npm run build
cd "$SCRIPT_DIR"

echo "=== [2/3] Go build ==="
go build -o floffi ./cmd/floffi

echo "=== [3/3] Server start (port $PORT) ==="
free_port

# Run server with line-buffered stdout/stderr so logs flush immediately
# (avoids Go's default block buffering when stdout isn't a TTY).
# `unbuffer` (from expect) or `stdbuf` would also work; we use the simpler
# approach of relying on Go's TTY detection — when start.sh is run from a
# terminal stdout IS a TTY so flushing is line-by-line. Just invoke directly.
echo
echo "server logs follow:"
echo
exec env FLOFFI_ALLOW_DEV_BIND="${FLOFFI_ALLOW_DEV_BIND:-1}" ./floffi serve --port "$PORT" $DOTENV_OPT
