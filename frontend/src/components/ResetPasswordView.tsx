import { useState } from "react";
import { completePasswordReset } from "../lib/auth";
import { PasswordInput } from "./PasswordInput";
import { checkPasswordStrength, describePasswordIssue } from "../lib/passwordStrength";

// ResetPasswordView — used when the URL is /reset?token=…. Lets the user
// pick a new password, posts to /api/auth/reset-password/complete, then
// hands control back to App via onDone (which clears the URL + flips to
// the login screen with a success message).

type ResetPasswordViewProps = {
  token: string;
  onDone: (ok: boolean, message: string) => void;
};

export function ResetPasswordView(props: ResetPasswordViewProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Reset flow doesn't know the user's identifiers (we'd have to peek
  // at the token before consuming it), so the username/email
  // containment branch is skipped — same as the server.
  const liveIssue = password ? checkPasswordStrength(password) : null;

  async function handleSubmit() {
    setError("");
    const issue = checkPasswordStrength(password);
    if (issue) {
      setError(describePasswordIssue(issue));
      return;
    }
    if (password !== confirm) {
      setError("비밀번호가 일치하지 않아요.");
      return;
    }
    setLoading(true);
    try {
      await completePasswordReset(props.token, password);
      props.onDone(true, "비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "재설정에 실패했어요.";
      const map: Record<string, string> = {
        token_expired: "링크가 만료되었어요. 비밀번호 재설정을 다시 요청해주세요.",
        token_used: "이미 사용된 링크예요. 새 링크를 받아주세요.",
        token_not_found: "유효하지 않은 링크예요.",
        weak_password: "비밀번호 정책에 맞지 않아요. 위 안내를 참고해주세요.",
      };
      setError(map[msg] ?? "재설정에 실패했어요. 잠시 후 다시 시도해주세요.");
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
            <h1 className="text-2xl font-black tracking-tight text-t1">새 비밀번호 설정</h1>
            <p className="mt-1 text-sm text-t3">새 비밀번호를 입력해주세요.</p>
          </div>
        </div>

        <div
          className="rounded-2xl border-2 border-bd/10 p-6"
          style={{
            background:
              "color-mix(in srgb, rgb(var(--base)) 96%, rgb(var(--ac)) 4%)",
          }}
        >
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
                새 비밀번호
              </label>
              <PasswordInput
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                placeholder="최소 10자, 두 가지 이상 조합"
                ariaLabel="새 비밀번호"
              />
              <p className={[
                "mt-1.5 text-[11px] leading-snug",
                liveIssue ? "text-amber-500" : "text-t3",
              ].join(" ")}>
                {liveIssue
                  ? describePasswordIssue(liveIssue)
                  : "10자 이상, 영문 대/소문자·숫자·기호 중 두 가지 이상 섞어주세요."}
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
                새 비밀번호 확인
              </label>
              <PasswordInput
                value={confirm}
                onChange={setConfirm}
                onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
                autoComplete="new-password"
                placeholder="한 번 더 입력"
                ariaLabel="새 비밀번호 확인"
              />
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-red-700/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={loading}
            className="mt-5 inline-flex w-full items-center justify-center rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-5 py-3.5 text-base font-black text-white outline-none transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "처리 중..." : "비밀번호 변경"}
          </button>
        </div>
      </div>
    </main>
  );
}
