import { useState } from "react";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  clearKey,
  getKey,
  maskKey,
  setKey,
  type LLMProvider,
} from "../lib/byok";
import { isProviderEnabled } from "../lib/models";
import { WarningIcon } from "./BoardView";

// validateKeyFormat does a cheap structural sanity check before we persist the
// key. We intentionally don't enforce an exact length — providers extend their
// key formats over time, and being too strict would reject valid keys. The
// goal is to catch the common paste mistakes (truncation, leading/trailing
// whitespace, wrong provider's key in this slot).
//
// All failure modes collapse to a single generic message: the key itself is a
// secret, and exposing its expected shape (prefix, length) in the UI would be
// a small but unnecessary information leak. Users only need to know "the key
// you typed doesn't look right" — they can re-check against their dashboard.
const INVALID_KEY_MESSAGE = "잘못된 API 키 형식입니다. 다시 확인해주세요.";

function validateKeyFormat(provider: LLMProvider, raw: string): string | null {
  const value = raw.trim();
  if (!value) return INVALID_KEY_MESSAGE;
  if (value !== raw) return INVALID_KEY_MESSAGE;
  if (/\s/.test(value)) return INVALID_KEY_MESSAGE;

  switch (provider) {
    case "gemini": {
      // Google API keys (Gemini / AI Studio) consistently begin with "AIzaSy"
      // and are ~39 chars. Lower bound of 30 leaves headroom for future length
      // changes without letting an obviously-truncated paste through.
      if (!value.startsWith("AIzaSy")) return INVALID_KEY_MESSAGE;
      if (value.length < 30) return INVALID_KEY_MESSAGE;
      return null;
    }
    case "openai": {
      if (!value.startsWith("sk-")) return INVALID_KEY_MESSAGE;
      // Common minimum across legacy and project-scoped keys.
      if (value.length < 20) return INVALID_KEY_MESSAGE;
      return null;
    }
    case "anthropic": {
      if (!value.startsWith("sk-ant-")) return INVALID_KEY_MESSAGE;
      if (value.length < 20) return INVALID_KEY_MESSAGE;
      return null;
    }
  }
}

// BYOKSection lets the user paste their own LLM provider keys. Keys live in
// localStorage, are sent via the X-LLM-Key header on each LLM request, and
// are wiped on logout (see App.tsx logout handler).
//
// Trade-offs documented in chat:
//   • localStorage is the right place because the server never holds the
//     user's key — no blast-radius on server compromise.
//   • XSS is the residual risk; CSP + no-HTML-rendering on the React side
//     mitigates that.
//   • Per-tab in-memory cache (this component's `keys` state) reads once at
//     mount and updates after every save so re-render reflects masked state.
export function BYOKSection({ onKeysChange }: {
  // Fires after every save / clear so parents that surface "키 등록 필요"
  // hints next to the provider toggle can stay in sync without polling
  // localStorage. Receives the post-mutation snapshot.
  onKeysChange?: (keys: Record<LLMProvider, string>) => void;
} = {}) {
  // Read all known keys at mount.
  const [keys, setKeys] = useState<Record<LLMProvider, string>>(() => ({
    gemini: getKey("gemini"),
    openai: getKey("openai"),
    anthropic: getKey("anthropic"),
  }));
  const [drafts, setDrafts] = useState<Record<LLMProvider, string>>({
    gemini: "",
    openai: "",
    anthropic: "",
  });
  // Per-provider inline error message. Empty string = no error. We keep the
  // error visible until the user edits the input again, so they can read it
  // while fixing — not the toast-and-disappear pattern.
  const [errors, setErrors] = useState<Record<LLMProvider, string>>({
    gemini: "",
    openai: "",
    anthropic: "",
  });

  function save(provider: LLMProvider) {
    const raw = drafts[provider];
    const err = validateKeyFormat(provider, raw);
    if (err) {
      setErrors((prev) => ({ ...prev, [provider]: err }));
      return;
    }
    const value = raw.trim();
    setKey(provider, value);
    const next = { ...keys, [provider]: value };
    setKeys(next);
    setDrafts((prev) => ({ ...prev, [provider]: "" }));
    setErrors((prev) => ({ ...prev, [provider]: "" }));
    onKeysChange?.(next);
  }

  function clear(provider: LLMProvider) {
    clearKey(provider);
    const next = { ...keys, [provider]: "" };
    setKeys(next);
    setErrors((prev) => ({ ...prev, [provider]: "" }));
    onKeysChange?.(next);
  }

  function updateDraft(provider: LLMProvider, value: string) {
    setDrafts((prev) => ({ ...prev, [provider]: value }));
    // Clear stale error as soon as the user resumes typing; revalidation
    // happens again on the next save click.
    setErrors((prev) => (prev[provider] ? { ...prev, [provider]: "" } : prev));
  }

  // Show the warning banner only when *no* usable (enabled) provider has a
  // stored BYOK key. Disabled providers (e.g. Anthropic "준비중") don't count
  // — their key wouldn't be usable anyway. False positives are possible when
  // the server itself has an env-var key set; the wording acknowledges that
  // ("환경변수 키가 설정되어 있지 않은 경우").
  const hasAnyKey = LLM_PROVIDERS.some((p) => isProviderEnabled(p) && !!keys[p]);

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-t3">
        본인의 API 키를 직접 입력하면 서버 환경변수 키 대신 사용됩니다. 키는 이 브라우저(localStorage)에만 저장되며 서버나 DB에 기록되지 않습니다. 로그아웃 시 자동 삭제됩니다.
      </p>

      {!hasAnyKey ? (
        <div role="alert" className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-bold leading-relaxed text-amber-700 dark:text-amber-400">
            <WarningIcon size={14} />
            <span>등록된 API 키가 없습니다</span>
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-800/85 dark:text-amber-300/85">
            서버에 환경변수 키가 설정되어 있지 않은 경우, 에이전트 실행 시 실패합니다. 아래에서 사용할 프로바이더의 키를 등록해주세요.
          </p>
        </div>
      ) : null}

      {LLM_PROVIDERS.map((provider) => {
        const stored = keys[provider];
        const draft = drafts[provider];
        const disabled = !isProviderEnabled(provider);
        return (
          <div key={provider} className={["rounded-xl border border-bd/10 bg-s2 p-3", disabled ? "opacity-60" : ""].join(" ")}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-bold text-t1">{PROVIDER_LABELS[provider]}</p>
              {disabled ? (
                <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700">준비중</span>
              ) : stored ? (
                <span className="rounded-md bg-ac/15 px-2 py-0.5 text-[10px] font-bold text-ac">저장됨</span>
              ) : (
                <span className="rounded-md bg-bd/15 px-2 py-0.5 text-[10px] font-bold text-t3">미등록</span>
              )}
            </div>

            {disabled ? null : stored ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg border border-bd/10 bg-s1 px-2.5 py-1.5 font-mono text-[11px] text-t2">
                  {maskKey(stored)}
                </code>
                <button
                  type="button"
                  onClick={() => clear(provider)}
                  className="rounded-lg border border-bd/10 bg-s1 px-2.5 py-1.5 text-[11px] font-bold text-t3 transition hover:bg-s3 hover:text-t1"
                >
                  삭제
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <input
                    id={`byok-input-${provider}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft}
                    onChange={(e) => updateDraft(provider, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") save(provider); }}
                    placeholder="API 키 붙여넣기"
                    aria-invalid={errors[provider] ? true : undefined}
                    aria-describedby={errors[provider] ? `byok-err-${provider}` : undefined}
                    className={[
                      "flex-1 rounded-lg border bg-s1 px-2.5 py-1.5 font-mono text-[11px] text-t1 placeholder:text-t3 transition",
                      errors[provider]
                        ? "border-err/60 focus:border-err focus:ring-2 focus:ring-err/20"
                        : "border-bd/10 focus:border-ac/50 focus:ring-2 focus:ring-ac/15",
                    ].join(" ")}
                  />
                  <button
                    type="button"
                    onClick={() => save(provider)}
                    disabled={!draft.trim()}
                    className="rounded-lg border border-ac/30 bg-ac/15 px-2.5 py-1.5 text-[11px] font-bold text-ac transition enabled:hover:bg-ac/25 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    저장
                  </button>
                </div>
                {errors[provider] ? (
                  <p id={`byok-err-${provider}`} role="alert"
                    className="mt-1.5 flex items-start gap-1.5 text-[11px] font-bold leading-relaxed text-err">
                    <WarningIcon size={12} className="mt-0.5 shrink-0" />
                    <span>{errors[provider]}</span>
                  </p>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
