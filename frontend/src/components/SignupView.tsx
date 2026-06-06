import { useEffect, useState } from "react";
import { PasswordInput } from "./PasswordInput";
import { checkPasswordStrength, describePasswordIssue, gradePasswordStrength, MIN_PASSWORD_LEN } from "../lib/passwordStrength";

type SignupViewProps = {
  loading: boolean;
  serverError: string;
  // nickname 은 비워서 보내면 서버가 이메일 local-part 로 채운다.
  onSubmit: (email: string, password: string, nickname: string) => void;
  onSwitchToLogin: () => void;
  invitePending?: boolean;
  inviteNotice?: string;
};

// Mirrors the server-side rules in internal/server/auth/handler.go so the
// user sees the same error before round-tripping. Username/handle is now
// generated server-side from the email's local-part, so the form only
// asks for email + password (+ optional nickname).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NICKNAME_MAX = 32;

// 이메일 입력 상태 — "확인중" 같은 진행 메시지는 노출하지 않는다.
// idle  : 아무것도 입력 안했거나 검사 전. 메시지 없음.
// invalid: 형식 오류. 빨강 경고.
// taken  : 이미 사용중. 빨강 경고.
// available: 사용 가능. 초록 안내.
type EmailStatus = "idle" | "invalid" | "taken" | "available";

export function SignupView(props: SignupViewProps) {
  const [email, setEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<EmailStatus>("idle");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [clientError, setClientError] = useState("");

  // Debounced email check. Fires 400ms after the last keystroke. We don't
  // surface any "확인중..." indicator while the request is in-flight; the
  // status only flips when we have a definitive answer. Stale responses
  // are dropped via the cancelled flag so faster-than-network typing
  // can't downgrade a newer email to an older email's verdict.
  useEffect(() => {
    const trimmed = email.trim().toLowerCase();
    if (trimmed === "") {
      setEmailStatus("idle");
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setEmailStatus("invalid");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/auth/check-email", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
        });
        if (cancelled) return;
        if (!res.ok) return;
        const body = (await res.json()) as { valid?: boolean; available?: boolean };
        if (cancelled) return;
        if (body.valid === false) {
          setEmailStatus("invalid");
        } else if (body.available === false) {
          setEmailStatus("taken");
        } else if (body.available === true) {
          setEmailStatus("available");
        }
      } catch {
        // Network/transient error — leave status as-is so we don't
        // surface a "확인 실패" message; the submit path will still
        // catch a real conflict server-side.
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [email]);

  function handleSubmit() {
    setClientError("");
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      setClientError("올바른 이메일 주소를 입력해주세요.");
      return;
    }
    if (emailStatus === "taken") {
      setClientError("이미 등록된 이메일이에요.");
      return;
    }
    const nick = nickname.trim();
    if ([...nick].length > NICKNAME_MAX) {
      setClientError(`닉네임은 최대 ${NICKNAME_MAX}자까지 가능해요.`);
      return;
    }
    const pwIssue = checkPasswordStrength(password, "", e);
    if (pwIssue) {
      setClientError(describePasswordIssue(pwIssue));
      return;
    }
    if (password !== confirm) {
      setClientError("비밀번호가 일치하지 않아요.");
      return;
    }
    props.onSubmit(e, password, nick);
  }

  // Live hint shown under the password input. Same checker the submit
  // path uses, so the user sees what's missing the moment they type
  // rather than after they hit 계정 만들기.
  const liveIssue = password ? checkPasswordStrength(password, "", email.trim().toLowerCase()) : null;
  const strengthGrade = gradePasswordStrength(password, "", email.trim().toLowerCase());

  const error = clientError || props.serverError;

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
            <h1 className="text-2xl font-black tracking-tight text-t1">계정 만들기</h1>
            <p className="mt-1 text-sm text-t3">Floffi에 오신 것을 환영합니다.</p>
          </div>
        </div>

        <div
          className="rounded-2xl border-2 border-bd/10 p-6"
          style={{
            background:
              "color-mix(in srgb, rgb(var(--base)) 96%, rgb(var(--ac)) 4%)",
          }}
        >
          {props.inviteNotice ? (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-t2">
              <p className="font-bold text-t1">초대 계정을 다시 확인해주세요.</p>
              <p className="mt-1 leading-relaxed">{props.inviteNotice}</p>
            </div>
          ) : null}
          {props.invitePending ? (
            <div className="mb-4 rounded-xl border border-ac/25 bg-ac/10 px-4 py-3 text-sm text-t2">
              <p className="font-bold text-t1">초대 링크로 들어왔어요.</p>
              <p className="mt-1 leading-relaxed">아직 계정이 없다면 초대받은 이메일로 가입하세요. 가입이 끝나면 같은 초대 흐름으로 바로 돌아갑니다.</p>
            </div>
          ) : null}
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
                이메일
              </label>
              <input
                type="email"
                className="w-full rounded-xl border-2 border-bd/10 px-4 py-3 text-t1 outline-none placeholder:text-t3 focus:outline-none"
                style={{
                  background:
                    "color-mix(in srgb, rgb(var(--base)) 92%, rgb(var(--ac)) 8%)",
                }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
              />
              {emailStatus === "invalid" ? (
                <p className="mt-1.5 text-[11px] leading-snug text-amber-500">올바른 이메일 주소를 입력해주세요.</p>
              ) : emailStatus === "taken" ? (
                <p className="mt-1.5 text-[11px] leading-snug text-red-500">이미 등록된 이메일이에요.</p>
              ) : emailStatus === "available" ? (
                <p className="mt-1.5 text-[11px] leading-snug text-emerald-500">사용 가능한 이메일이에요.</p>
              ) : null}
            </div>

            <div>
              <label className="mb-1.5 flex items-center justify-between text-[11px] font-black uppercase tracking-wider text-t3">
                <span>닉네임 <span className="ml-1 text-[10px] font-bold normal-case tracking-normal text-t3/70">(선택)</span></span>
              </label>
              <input
                type="text"
                className="w-full rounded-xl border-2 border-bd/10 px-4 py-3 text-t1 outline-none placeholder:text-t3 focus:outline-none"
                style={{
                  background:
                    "color-mix(in srgb, rgb(var(--base)) 92%, rgb(var(--ac)) 8%)",
                }}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={NICKNAME_MAX * 2}
                autoComplete="nickname"
                placeholder="비워두면 이메일 앞부분이 사용돼요"
              />
              <p className="mt-1.5 text-[11px] leading-snug text-t3">
                상단바와 아바타에 표시되는 이름이에요. 가입 후에도 변경할 수 있어요.
              </p>
            </div>

            <div>
              <label className="mb-1.5 flex items-center justify-between text-[11px] font-black uppercase tracking-wider text-t3">
                <span>비밀번호</span>
                {strengthGrade ? (
                  <span
                    className={[
                      "text-[10px] font-black tracking-normal normal-case",
                      strengthGrade.level === 0 ? "text-red-500"
                      : strengthGrade.level === 1 ? "text-amber-500"
                      : strengthGrade.level === 2 ? "text-emerald-500"
                      : "text-emerald-400",
                    ].join(" ")}
                    aria-live="polite"
                  >
                    {strengthGrade.label}
                  </span>
                ) : null}
              </label>
              <PasswordInput
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                placeholder="최소 10자, 두 가지 이상 조합"
                ariaLabel="비밀번호"
              />
              {strengthGrade ? (
                <div
                  className="mt-2 grid grid-cols-4 gap-1"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={3}
                  aria-valuenow={strengthGrade.level}
                  aria-label={`비밀번호 강도: ${strengthGrade.label}`}
                >
                  {[0, 1, 2, 3].map((i) => {
                    const filled = i <= strengthGrade.level;
                    const tone =
                      strengthGrade.level === 0 ? "bg-red-500"
                      : strengthGrade.level === 1 ? "bg-amber-500"
                      : strengthGrade.level === 2 ? "bg-emerald-500"
                      : "bg-emerald-400";
                    return (
                      <span
                        key={i}
                        className={[
                          "h-1.5 rounded-full transition-colors",
                          filled ? tone : "bg-bd/15",
                        ].join(" ")}
                      />
                    );
                  })}
                </div>
              ) : null}
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
                비밀번호 확인
              </label>
              <PasswordInput
                value={confirm}
                onChange={setConfirm}
                onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
                autoComplete="new-password"
                placeholder="한 번 더 입력해주세요"
                ariaLabel="비밀번호 확인"
              />
              {confirm.length > 0 && confirm !== password ? (
                <p className="mt-1.5 text-[11px] leading-snug text-red-500">비밀번호가 일치하지 않아요.</p>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-red-700/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={props.loading}
            data-role="primary-btn"
            className="mt-5 inline-flex w-full items-center justify-center rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-5 py-3.5 text-base font-black text-white outline-none transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {props.loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                계정 만드는 중...
              </span>
            ) : (
              "계정 만들기"
            )}
          </button>

          <button
            type="button"
            onClick={props.onSwitchToLogin}
            className="mt-3 inline-flex w-full items-center justify-center rounded-xl border-2 border-bd/10 px-5 py-3.5 text-base font-bold text-t2 outline-none transition focus:outline-none"
            style={{
              background:
                "color-mix(in srgb, rgb(var(--base)) 92%, rgb(var(--ac)) 8%)",
            }}
          >
            로그인
          </button>
        </div>
      </div>
    </main>
  );
}
