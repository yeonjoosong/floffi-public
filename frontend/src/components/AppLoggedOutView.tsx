import type { IdleLogoutReason } from "../lib/idleTimer";
import { startPasswordReset } from "../lib/auth";
import { useEscapeClose } from "../lib/escapeStack";
import { ConfirmToast } from "./ConfirmToast";
import { LoginView } from "./LoginView";
import { ModalCloseButton } from "./ModalCloseButton";
import { SignupView } from "./SignupView";

type VerifyResult = { ok: boolean; message: string } | null;

type AppLoggedOutViewProps = {
  authMode: "login" | "signup";
  loginLoading: boolean;
  loginError: string;
  email: string;
  password: string;
  autoLogoutReason: IdleLogoutReason | null;
  verifyResult: VerifyResult;
  resetSuccessMessage: string;
  accountDeletedMessage: string;
  invitePending: boolean;
  inviteNotice: string;
  forgotOpen: boolean;
  forgotEmail: string;
  forgotSent: boolean;
  lockedDialog: boolean;
  onSubmitLogin: () => void;
  onSubmitSignup: (emailRaw: string, password: string, nicknameRaw: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSwitchToLogin: () => void;
  onSwitchToSignup: () => void;
  onForgotOpen: () => void;
  onAutoLogoutAcknowledge: () => void;
  onClearVerifyResult: () => void;
  onClearResetSuccessMessage: () => void;
  onClearAccountDeletedMessage: () => void;
  onForgotEmailChange: (value: string) => void;
  onForgotClose: () => void;
  onForgotSent: () => void;
  onLockedDialogClose: () => void;
  onLockedResetPassword: () => void;
};

export function AppLoggedOutView(props: AppLoggedOutViewProps) {
  useEscapeClose(props.lockedDialog, props.onLockedDialogClose);
  useEscapeClose(props.forgotOpen, props.onForgotClose);

  if (props.authMode === "signup") {
    return (
      <SignupView
        loading={props.loginLoading}
        serverError={props.loginError}
        invitePending={props.invitePending}
        inviteNotice={props.inviteNotice}
        onSubmit={props.onSubmitSignup}
        onSwitchToLogin={props.onSwitchToLogin}
      />
    );
  }

  return (
    <>
      <ConfirmToast
        open={props.autoLogoutReason !== null}
        title="자동 로그아웃 되었습니다"
        message={
          props.autoLogoutReason === "absolute"
            ? "장시간 사용으로 자동 로그아웃 되었습니다. 다시 로그인해주세요."
            : props.autoLogoutReason === "kicked"
              ? "다른 기기에서 로그인되어 이 세션이 자동으로 종료되었습니다. 본인이 아니라면 비밀번호를 변경해주세요."
              : "장시간 미사용으로 자동 로그아웃 되었습니다. 다시 로그인해주세요."
        }
        confirmLabel="확인"
        hideCancel
        dismissOnBackdrop={false}
        onConfirm={props.onAutoLogoutAcknowledge}
        onCancel={props.onAutoLogoutAcknowledge}
      />
      <ConfirmToast
        open={!!props.verifyResult}
        title={props.verifyResult?.ok ? "이메일 인증 완료" : "이메일 인증 실패"}
        message={props.verifyResult?.message ?? ""}
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onClearVerifyResult}
        onCancel={props.onClearVerifyResult}
      />
      <ConfirmToast
        open={!!props.resetSuccessMessage}
        title="비밀번호 변경 완료"
        message={props.resetSuccessMessage}
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onClearResetSuccessMessage}
        onCancel={props.onClearResetSuccessMessage}
      />
      <ConfirmToast
        open={!!props.accountDeletedMessage}
        title="회원 탈퇴 완료"
        message={props.accountDeletedMessage}
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onClearAccountDeletedMessage}
        onCancel={props.onClearAccountDeletedMessage}
      />
      <LoginView
        email={props.email}
        password={props.password}
        loading={props.loginLoading}
        error={props.loginError}
        invitePending={props.invitePending}
        inviteNotice={props.inviteNotice}
        onEmailChange={props.onEmailChange}
        onPasswordChange={props.onPasswordChange}
        onSubmit={props.onSubmitLogin}
        onSwitchToSignup={props.onSwitchToSignup}
        onForgotPassword={props.onForgotOpen}
      />
      {props.lockedDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div data-role="modal-window" className="relative w-full max-w-sm rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
            <ModalCloseButton onClose={props.onLockedDialogClose} />
            <div data-role="modal-titlebar" className="rounded-t-2xl border-b border-bd/10 px-6 py-4 pr-12">
              <h2 className="text-lg font-black tracking-tight">계정이 잠겼어요</h2>
            </div>
            <div className="px-6 py-5">
              <p className="text-sm leading-relaxed text-t2">
                비밀번호 5회 오류로 사용이 제한된 계정입니다. 비밀번호를 재설정 해주세요.
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  onClick={props.onLockedDialogClose}
                  className="flex-1 rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2.5 text-sm font-bold text-t2"
                >
                  닫기
                </button>
                <button
                  type="button"
                  onClick={props.onLockedResetPassword}
                  className="flex-1 rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2.5 text-sm font-black text-white"
                >
                  비밀번호 재설정
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {props.forgotOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div data-role="modal-window" className="relative w-full max-w-sm rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
            <ModalCloseButton onClose={props.onForgotClose} />
            <div data-role="modal-titlebar" className="rounded-t-2xl border-b border-bd/10 px-6 py-4 pr-12">
              <h2 className="text-lg font-black tracking-tight">비밀번호 재설정</h2>
            </div>
            <div className="px-6 py-5">
              <p className="text-sm text-t3">가입 시 사용한 이메일을 입력하면 재설정 링크를 보내드려요.</p>
              {props.forgotSent ? (
                <p className="mt-4 rounded-xl border border-ac/30 bg-ac/15 px-3 py-2 text-sm text-t1">
                  입력한 이메일이 가입되어 있다면 재설정 링크가 전송됩니다. 메일함을 확인해주세요.
                </p>
              ) : (
                <input
                  type="email"
                  value={props.forgotEmail}
                  onChange={(e) => props.onForgotEmailChange(e.target.value)}
                  className="mt-3 w-full rounded-xl border-2 border-bd/10 bg-s2 px-4 py-3 text-t1 outline-none focus:outline-none"
                  placeholder="you@example.com"
                />
              )}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={props.onForgotClose}
                  className="flex-1 rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2.5 text-sm font-bold text-t2"
                >
                  닫기
                </button>
                {!props.forgotSent ? (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await startPasswordReset(props.forgotEmail.trim().toLowerCase());
                      } catch {
                        // always shown as success per spec
                      }
                      props.onForgotSent();
                    }}
                    disabled={!props.forgotEmail.trim()}
                    className="flex-1 rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2.5 text-sm font-black text-white disabled:opacity-60"
                  >
                    링크 받기
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
