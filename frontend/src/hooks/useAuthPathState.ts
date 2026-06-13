import { useEffect, useState } from "react";
import { completeEmailVerify } from "../lib/auth";
import { consumePendingInviteToken, rememberPendingInviteToken } from "../components/InviteAcceptView";

const INVITE_LOGIN_NOTICE: Record<string, string> = {
  invitation_email_mismatch: "초대받은 다른 이메일 계정으로 다시 로그인해주세요. 로그인 후 초대 수락을 자동으로 다시 시도합니다.",
};

export type AuthPathView =
  | { kind: "reset"; token: string }
  | { kind: "invite"; token: string }
  | null;

export function useAuthPathState(sessionAuthenticated: boolean) {
  const [pathView, setPathView] = useState<AuthPathView>(null);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [resetSuccessMessage, setResetSuccessMessage] = useState("");
  const [accountDeletedMessage, setAccountDeletedMessage] = useState("");
  const [inviteLoginNotice, setInviteLoginNotice] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    const path = url.pathname;
    const token = url.searchParams.get("token") ?? "";
    if (path === "/verify" && token) {
      void (async () => {
        try {
          await completeEmailVerify(token);
          setVerifyResult({ ok: true, message: "이메일 인증이 완료되었어요." });
        } catch {
          setVerifyResult({ ok: false, message: "인증 링크가 유효하지 않아요. 다시 요청해주세요." });
        } finally {
          window.history.replaceState({}, "", "/");
        }
      })();
    } else if (path === "/reset" && token) {
      setPathView({ kind: "reset", token });
    } else if (path === "/invite" && token) {
      rememberPendingInviteToken(token);
      setPathView({ kind: "invite", token });
    }
  }, []);

  useEffect(() => {
    if (!sessionAuthenticated) return;
    if (pathView) return;
    const token = consumePendingInviteToken();
    if (!token) return;
    setPathView({ kind: "invite", token });
    window.history.replaceState({}, "", "/invite?token=" + encodeURIComponent(token));
  }, [sessionAuthenticated, pathView]);

  return {
    pathView,
    setPathView,
    verifyResult,
    setVerifyResult,
    resetSuccessMessage,
    setResetSuccessMessage,
    accountDeletedMessage,
    setAccountDeletedMessage,
    inviteLoginNotice,
    setInviteLoginNotice,
    describeInviteLoginNotice: (code: string) => INVITE_LOGIN_NOTICE[code] ?? "",
  };
}
