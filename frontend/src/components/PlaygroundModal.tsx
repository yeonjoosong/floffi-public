import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { runPlayground } from "../lib/board";
import { useEscapeClose } from "../lib/escapeStack";
import { ModalCloseButton } from "./ModalCloseButton";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  getKey,
  type LLMProvider,
} from "../lib/byok";
import { MODEL_OPTIONS, defaultModelFor, isProviderEnabled } from "../lib/models";
import {
  DRAFTS_FLUSH_EVENT,
  DRAFTS_RESTORE_EVENT,
  readDrafts,
  setPlaygroundDraft,
  type IdleDraftsPayload,
} from "../lib/idleDrafts";

// PlaygroundModal — case-by-case model tester. Each "case" is independent:
// pick provider + model, enter prompt, run, see latency + response. Multiple
// runs are kept in the panel until the user clears them, so the user can
// compare provider/model behaviour side by side.
//
// Sends X-LLM-Key automatically when a BYOK key is stored for the provider;
// otherwise falls back to the server's env-var key. Latency is measured
// server-side (around the upstream HTTP call) for accuracy.

type RunResult = {
  id: string;
  provider: LLMProvider;
  model: string;
  prompt: string;
  text?: string;
  error?: string;
  latencyMs: number;
  ranAt: string;
};

export function PlaygroundModal({ onClose }: { onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [provider, setProvider] = useState<LLMProvider>("gemini");
  const [model, setModel] = useState<string>(defaultModelFor("gemini"));
  const [prompt, setPrompt] = useState<string>("안녕하세요! 짧게 자기소개 해주세요.");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);

  useEscapeClose(true, onClose);

  // idle-logout flush: 모달이 열려 있을 때 provider/model/prompt/results 를
  // idleDrafts 로 덤프한다. results 가 과도하게 길면(>100) 의미 없는 누적
  // 덩어리로 보고 잘라 낸다.
  useEffect(() => {
    const onFlush = () => {
      const trimmed = results.length > 100 ? [] : results;
      setPlaygroundDraft({
        provider,
        model,
        prompt,
        results: trimmed,
      });
    };
    window.addEventListener(DRAFTS_FLUSH_EVENT, onFlush);
    return () => window.removeEventListener(DRAFTS_FLUSH_EVENT, onFlush);
  }, [provider, model, prompt, results]);

  // 로그인 후 restore: 마운트 직후 1회만 hydrate 한다.
  //
  // 두 경로를 모두 지원해야 한다:
  //  1) 모달이 이미 열려 있을 때 App.tsx 가 DRAFTS_RESTORE_EVENT 를 dispatch.
  //  2) 로그인 직후 idleDrafts 가 이미 발사된 뒤 모달이 새로 열린 경우
  //     — 이때는 이벤트 리스너만 등록한 채 가만히 있으면 영원히 hydrate 안 됨.
  //     mount 시 readDrafts() 로 localStorage 의 잔여 payload 를 한 번 더
  //     읽어 fallback 으로 hydrate 한다. (localStorage 정리는 App 이
  //     restore 후 했지만, 동일 세션에서 다시 모달을 열면 in-memory cache 가
  //     필요하므로 App 은 정리하기 전 idleDrafts 의 cache 에 보관한다.)
  const restoredRef = useRef(false);
  useEffect(() => {
    function applyPlayground(p: NonNullable<IdleDraftsPayload["playground"]>) {
      if (restoredRef.current) return;
      restoredRef.current = true;
      if (typeof p.provider === "string" && (LLM_PROVIDERS as readonly string[]).includes(p.provider)) {
        const next = p.provider as LLMProvider;
        setProvider(next);
        const valid = MODEL_OPTIONS[next].some((opt) => opt.id === p.model);
        setModel(valid ? (p.model as string) : defaultModelFor(next));
      } else if (typeof p.model === "string") {
        setModel(p.model);
      }
      if (typeof p.prompt === "string") setPrompt(p.prompt);
      if (Array.isArray(p.results)) {
        const sane = p.results
          .filter((r) => (LLM_PROVIDERS as readonly string[]).includes(r.provider))
          .map((r) => ({ ...r, provider: r.provider as LLMProvider }));
        setResults(sane);
      }
    }
    const onRestore = (ev: Event) => {
      const ce = ev as CustomEvent<IdleDraftsPayload>;
      const p = ce.detail?.playground;
      if (p) applyPlayground(p);
    };
    window.addEventListener(DRAFTS_RESTORE_EVENT, onRestore as EventListener);
    // mount-time fallback: 모달이 로그인 이후에 열렸다면 이벤트를 못 받으므로
    // 직접 읽는다. 한 번 hydrate 한 뒤에는 restoredRef 가 막아 준다.
    const cached = readDrafts();
    if (cached?.playground) applyPlayground(cached.playground);
    return () => window.removeEventListener(DRAFTS_RESTORE_EVENT, onRestore as EventListener);
  }, []);

  function changeProvider(p: LLMProvider) {
    if (!isProviderEnabled(p)) return;
    setProvider(p);
    setModel(defaultModelFor(p));
  }

  async function run() {
    if (!prompt.trim() || running) return;
    setRunning(true);
    const id = `run-${Date.now()}`;
    const ranAt = new Date().toLocaleTimeString();
    try {
      const res = await runPlayground(provider, model, prompt);
      setResults((prev) => [
        { id, provider, model, prompt, text: res.text, error: res.error, latencyMs: res.latencyMs, ranAt },
        ...prev,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      setResults((prev) => [
        { id, provider, model, prompt, error: message, latencyMs: 0, ranAt },
        ...prev,
      ]);
    } finally {
      setRunning(false);
    }
  }

  const hasKey = getKey(provider).length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      // No backdrop click-to-close: the playground accumulates an
      // in-progress prompt + a history of test runs, so an accidental
      // outside click would wipe valuable work. Dismiss is explicit
      // via the X button or the ESC key (useEscapeClose above).
      role="dialog" aria-modal="true"
    >
      <div data-role="modal-window" className="relative flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-bd/15 bg-s1 shadow-2xl">
        {/* Header */}
        <div data-role="modal-titlebar" className="relative flex shrink-0 items-center justify-center rounded-t-2xl border-b border-bd/10 bg-s1 px-6 py-4">
          <p className="text-base font-black text-t1">모델 테스트 플레이그라운드</p>
          <ModalCloseButton onClose={onClose} />
        </div>

        {/* Form */}
        <div className="shrink-0 space-y-3 border-b border-bd/10 px-6 py-4">
          {/* Provider row — pills split the row evenly regardless of
              count (1 fills, 2 halve, 3 third each). */}
          <div>
            <p className="mb-1 text-[11px] font-bold text-t3">프로바이더</p>
            <div className="flex gap-1">
              {LLM_PROVIDERS.map((p) => {
                const isEnabled = isProviderEnabled(p);
                return (
                  <button key={p} type="button" onClick={() => changeProvider(p)}
                    disabled={!isEnabled}
                    title={!isEnabled ? "준비중" : undefined}
                    className={[
                      "min-w-0 flex-1 whitespace-nowrap rounded-lg border px-2 py-1.5 text-[11px] font-bold transition",
                      !isEnabled
                        ? "cursor-not-allowed border-bd/10 bg-s2 text-t3 opacity-50"
                        : provider === p
                          ? "border-ac/40 bg-ac/15 text-ac"
                          : "border-bd/10 bg-s2 text-t2 hover:bg-s3 hover:text-t1",
                    ].join(" ")}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Model row — select takes the full width. The key-source
              indicator (개인 / 서버) used to live in its own column,
              which created an awkward orphan pill at narrow widths.
              Move it inline next to the 모델 label as a small badge so
              it travels with what it describes (which model is hit
              with which key) and the form stays one column wide on
              phones. */}
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <p className="text-[11px] font-bold text-t3">모델</p>
              <span className={[
                "inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-bold leading-4",
                hasKey ? "border-ac/30 bg-ac/15 text-ac" : "border-bd/10 bg-bd/15 text-t3",
              ].join(" ")} title={hasKey ? "개인 BYOK 키 사용" : "서비스 기본 키 사용"}>
                {hasKey ? "개인" : "기본"}
              </span>
            </div>
            <select value={model} onChange={(e) => setModel(e.target.value)}
              className="select-compact w-full cursor-pointer rounded-lg border border-bd/10 bg-s2 pl-2.5 pr-7 py-1.5 text-[11px] text-t1 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15"
            >
              {MODEL_OPTIONS[provider].map((opt) => {
                const showTier = opt.tier === "free" || opt.tier === "standard";
                return (
                  <option key={opt.id} value={opt.id}>
                    {opt.id}{showTier ? ` (${opt.tier})` : ""}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-bold text-t3">프롬프트</p>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="모델에게 보낼 프롬프트…"
              className="w-full max-h-80 resize-y rounded-lg border border-bd/10 bg-s2 px-3 py-2 text-xs leading-relaxed text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15"
            />
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void run()} disabled={running || !prompt.trim()}
              className="rounded-lg border border-ac/30 bg-ac/15 px-3 py-1.5 text-xs font-bold text-ac transition enabled:hover:bg-ac/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "실행 중…" : "테스트 실행"}
            </button>
            {results.length > 0 && (
              <button type="button" onClick={() => setResults([])}
                className="rounded-lg border border-bd/10 bg-s2 px-3 py-1.5 text-xs font-bold text-t3 transition hover:bg-s3 hover:text-t1"
              >
                결과 비우기
              </button>
            )}
            <span className="text-[11px] text-t3">
              {results.length === 0 ? "결과 0건" : `${results.length}건의 케이스 누적됨`}
            </span>
          </div>
        </div>

        {/* Results */}
        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {results.length === 0 ? (
            <p className="py-12 text-center text-xs text-t3">아직 실행된 케이스가 없습니다.</p>
          ) : (
            <div className="space-y-3">
              {results.map((r) => (
                <div key={r.id} className="rounded-xl border border-bd/10 bg-s2 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[11px]">
                    <span className="rounded-md bg-ac/15 px-2 py-0.5 font-bold text-ac">{PROVIDER_LABELS[r.provider]}</span>
                    <code className="rounded-md bg-s1 px-2 py-0.5 font-mono text-t2">{r.model}</code>
                    <span className={r.error ? "text-red-400" : "text-t3"}>{r.latencyMs}ms</span>
                    <span className="text-t3">· {r.ranAt}</span>
                  </div>
                  <p className="mb-1 text-[11px] font-bold text-t3">프롬프트</p>
                  <pre className="mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-s1 px-2.5 py-2 text-[11px] leading-relaxed text-t2">{r.prompt}</pre>
                  <p className="mb-1 text-[11px] font-bold text-t3">{r.error ? "오류" : "응답"}</p>
                  <pre className={[
                    "max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg px-2.5 py-2 text-[11px] leading-relaxed",
                    r.error ? "bg-red-500/10 text-red-300" : "bg-s1 text-t1",
                  ].join(" ")}>
                    {r.error ?? r.text ?? "(빈 응답)"}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
