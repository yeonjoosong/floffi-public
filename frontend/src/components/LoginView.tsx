import { PasswordInput } from "./PasswordInput";

type LoginViewProps = {
  email: string;
  password: string;
  loading: boolean;
  error: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onSwitchToSignup: () => void;
  onForgotPassword: () => void;
  invitePending?: boolean;
  inviteNotice?: string;
};

export function LoginView(props: LoginViewProps) {
  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-6"
      style={{
        background:
          "color-mix(in srgb, rgb(var(--base)) 97%, rgb(var(--ac)) 3%)",
      }}
    >
      <div className="relative w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-ac-lo to-ac-hi text-xl font-black text-white">
            FL
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-black tracking-tight text-t1">Floffi</h1>
            <p className="mt-1 text-sm text-t3">AI 에이전트 오케스트레이션</p>
          </div>
        </div>

        {/* Card */}
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
              <p className="font-bold text-t1">초대 링크를 확인하려면 먼저 로그인해야 해요.</p>
              <p className="mt-1 leading-relaxed">초대받은 이메일 계정으로 로그인하면 워크스페이스 참여를 바로 이어서 진행합니다.</p>
            </div>
          ) : null}
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
                이메일
              </label>
              {/* type="text" 로 유지 — 레거시 admin 계정만 username
                  ("admin") 으로도 로그인 가능해야 해서 서버는 여전히
                  email/handle 양쪽을 받지만, UI 상으로는 이메일만
                  안내한다. autocomplete="username" 은 HTML 표준에서
                  "로그인 식별자" 를 의미하므로 type 과 무관하게 그대로. */}
              <input
                type="text"
                className="w-full rounded-xl border-2 border-bd/10 px-4 py-3 text-t1 outline-none ring-0 placeholder:text-t3 focus:outline-none focus:ring-0 focus-visible:outline-none"
                style={{
                  background:
                    "color-mix(in srgb, rgb(var(--base)) 92%, rgb(var(--ac)) 8%)",
                }}
                value={props.email}
                onChange={(e) => props.onEmailChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") props.onSubmit(); }}
                autoComplete="username"
                autoFocus
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
                비밀번호
              </label>
              <PasswordInput
                value={props.password}
                onChange={props.onPasswordChange}
                onKeyDown={(e) => { if (e.key === "Enter") props.onSubmit(); }}
                autoComplete="current-password"
                placeholder="비밀번호를 입력하세요"
              />
            </div>
          </div>

          {props.error ? (
            <div className="mt-4 rounded-xl border border-red-700/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
              {props.error}
            </div>
          ) : null}

          <button
            type="button"
            onClick={props.onSubmit}
            disabled={props.loading}
            data-role="primary-btn"
            className="mt-5 inline-flex w-full items-center justify-center rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-5 py-3.5 text-base font-black text-white outline-none ring-0 transition focus:outline-none focus:ring-0 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {props.loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                로그인 중...
              </span>
            ) : (
              "로그인"
            )}
          </button>

          {/* Secondary actions keep only the flows that are implemented and
              useful in the public-facing build. */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={props.onForgotPassword}
              className="rounded-xl border border-bd/10 px-2 py-2.5 text-[12px] font-bold text-t2 outline-none transition hover:text-t1 focus:outline-none"
              style={{
                background:
                  "color-mix(in srgb, rgb(var(--base)) 94%, rgb(var(--ac)) 6%)",
              }}
            >
              비밀번호 찾기
            </button>
            <button
              type="button"
              onClick={props.onSwitchToSignup}
              className="rounded-xl border border-ac/30 px-2 py-2.5 text-[12px] font-bold text-ac outline-none transition hover:bg-ac/15 focus:outline-none"
              style={{
                background:
                  "color-mix(in srgb, rgb(var(--base)) 90%, rgb(var(--ac)) 10%)",
              }}
            >
              회원가입
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
