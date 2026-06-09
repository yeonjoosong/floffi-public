import { useState } from "react";
import { verifyRecoveryChallenge, verifyTOTPChallenge } from "../lib/auth";
import type { Session } from "../lib/types";

// MFAChallengeView — shown when /api/auth/login responds with mfaRequired.
// Lets the user enter either a 6-digit TOTP code or an 8-char recovery
// code. On success, hands the new Session back via onDone.

type MFAChallengeViewProps = {
  challengeToken: string;
  onDone: (session: Session) => void;
  onCancel: () => void;
};

export function MFAChallengeView(props: MFAChallengeViewProps) {
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    if (!code.trim() || loading) return;
    setError("");
    setLoading(true);
    try {
      const session = mode === "totp"
        ? await verifyTOTPChallenge(props.challengeToken, code.trim())
        : await verifyRecoveryChallenge(props.challengeToken, code.trim());
      props.onDone(session);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("invalid_code")) {
        setError("코드가 일치하지 않아요. 다시 입력해주세요.");
      } else if (msg.includes("challenge_invalid")) {
        setError("세션이 만료되었어요. 다시 로그인해주세요.");
      } else {
        setError("인증에 실패했어요. 잠시 후 다시 시도해주세요.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-6"
      style={{
        background:
          "color-mix(in srgb, rgb(var(--base)) 97%, rgb(var(--ac)) 3%)",
      }}
    >
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-ac-lo to-ac-hi text-xl font-black text-white">
            FL
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-black tracking-tight text-t1">2단계 인증</h1>
            <p className="mt-1 text-sm text-t3">
              {mode === "totp"
                ? "인증 앱에 표시된 6자리 코드를 입력해주세요."
                : "복구 코드 한 개를 입력해주세요."}
            </p>
          </div>
        </div>

        <div
          className="rounded-2xl border-2 border-bd/10 p-6"
          style={{
            background:
              "color-mix(in srgb, rgb(var(--base)) 96%, rgb(var(--ac)) 4%)",
          }}
        >
          <div className="space-y-3">
            <input
              type="text"
              inputMode={mode === "totp" ? "numeric" : "text"}
              className="w-full rounded-xl border-2 border-bd/10 px-4 py-3 text-center font-mono text-lg tracking-widest text-t1 outline-none focus:outline-none"
              style={{
                background:
                  "color-mix(in srgb, rgb(var(--base)) 92%, rgb(var(--ac)) 8%)",
              }}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
              placeholder={mode === "totp" ? "123 456" : "XXXX-XXXX"}
              autoFocus
            />
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-red-700/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={loading || !code.trim()}
            className="mt-5 inline-flex w-full items-center justify-center rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-5 py-3.5 text-base font-black text-white outline-none transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "확인 중..." : "확인"}
          </button>

          <button
            type="button"
            onClick={() => { setMode(mode === "totp" ? "recovery" : "totp"); setCode(""); setError(""); }}
            className="mt-3 inline-flex w-full items-center justify-center rounded-xl border-2 border-bd/10 px-5 py-2 text-sm font-bold text-t2 outline-none transition focus:outline-none"
            style={{
              background:
                "color-mix(in srgb, rgb(var(--base)) 92%, rgb(var(--ac)) 8%)",
            }}
          >
            {mode === "totp" ? "복구 코드로 인증" : "인증 앱 코드로 돌아가기"}
          </button>

          <button
            type="button"
            onClick={props.onCancel}
            className="mt-2 inline-flex w-full items-center justify-center px-5 py-2 text-xs font-bold text-t3 outline-none transition focus:outline-none"
          >
            로그인 취소
          </button>
        </div>
      </div>
    </main>
  );
}
