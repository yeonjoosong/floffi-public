import { useEffect, useRef, useState } from "react";
import { acceptInvitation } from "../lib/workspaces";

// InviteAcceptView — 초대 링크(/invite?token=…) 도착 화면.
//
// 흐름:
//   1) 마운트 시 URL 의 ?token 을 읽고 sessionStorage 에 보존
//      (로그인 단계로 빠지더라도 돌아왔을 때 다시 자동 수락 가능)
//   2) 인증된 사용자면 즉시 /api/workspaces/invitations/accept 호출
//   3) 성공 → 부모(App)가 워크스페이스 목록을 다시 받아 새 워크스페이스로
//      자동 전환. 이 화면은 "참여 완료" 메시지를 잠깐 띄운 뒤 홈으로
//   4) 실패 → 코드별 친절한 메시지 + 메인으로 돌아갈 수 있는 버튼
//
// 미인증인 경우의 분기는 부모(App) 에서 처리한다 — 이 컴포넌트는 항상
// "이미 로그인된 사용자가 토큰을 갖고 있다" 는 전제로 동작한다.

const INVITE_TOKEN_KEY = "floffi.pendingInviteToken";

export type InviteOutcome =
  | { kind: "ok"; workspaceId: string }
  | { kind: "error"; code: string };

export function rememberPendingInviteToken(token: string): void {
  try { window.sessionStorage.setItem(INVITE_TOKEN_KEY, token); } catch { /* ignore */ }
}

export function clearPendingInviteToken(): void {
  try { window.sessionStorage.removeItem(INVITE_TOKEN_KEY); } catch { /* ignore */ }
}

export function consumePendingInviteToken(): string {
  try {
    const t = window.sessionStorage.getItem(INVITE_TOKEN_KEY) ?? "";
    window.sessionStorage.removeItem(INVITE_TOKEN_KEY);
    return t;
  } catch {
    return "";
  }
}

// 코드 → 사용자에게 보일 한국어 메시지. 백엔드 handleInvitationAccept 에서
// 내려오는 코드 셋과 1:1 매칭.
const ERROR_MESSAGES: Record<string, { title: string; body: string }> = {
  invitation_not_found: {
    title: "초대를 찾을 수 없어요",
    body: "링크가 잘못되었거나 이미 처리된 초대일 수 있어요. 초대해준 분에게 새 링크를 받아주세요.",
  },
  invitation_expired: {
    title: "초대가 만료되었어요",
    body: "초대 링크는 발급 후 7일 동안만 유효해요. 새 링크를 받아 다시 시도해주세요.",
  },
  invitation_used: {
    title: "이미 사용된 초대예요",
    body: "이 링크는 한 번만 쓸 수 있어요. 이미 멤버라면 워크스페이스 스위처에서 바로 전환할 수 있어요.",
  },
  invitation_email_mismatch: {
    title: "초대받은 계정이 아니에요",
    body: "이 초대 링크는 다른 이메일 계정으로 발급되었어요. 초대받은 계정으로 다시 로그인한 뒤 시도해주세요.",
  },
  workspace_cap_reached: {
    title: "워크스페이스 개수가 가득 찼어요",
    body: "이 계정이 들어갈 수 있는 워크스페이스 수에 도달했어요. 기존 워크스페이스 중 하나를 떠나거나 관리자에게 정원 확장을 요청하세요.",
  },
  already_member: {
    title: "이미 참여 중인 워크스페이스예요",
    body: "이 계정은 이미 이 워크스페이스의 멤버예요. 상단 스위처에서 바로 전환할 수 있어요.",
  },
  workspace_deleted: {
    title: "워크스페이스를 더 이상 찾을 수 없어요",
    body: "초대가 발급된 뒤 워크스페이스가 삭제되었거나 닫혔어요. 초대해준 분에게 새 워크스페이스 상태를 확인해달라고 요청해주세요.",
  },
  workspace_not_found: {
    title: "워크스페이스를 찾을 수 없어요",
    body: "초대 대상 워크스페이스가 더 이상 유효하지 않아요. 초대해준 분에게 새 링크를 요청해주세요.",
  },
  invalid_json: {
    title: "초대 토큰이 비어 있어요",
    body: "링크에 토큰이 빠져 있어요. 초대해준 분에게 다시 받아주세요.",
  },
};


function shouldPreserveInviteToken(code: string): boolean {
  return code === "invitation_email_mismatch";
}

function actionLabel(code: string): string {
  if (code === "invitation_email_mismatch") return "다른 계정으로 로그인";
  return "메인으로";
}

function describe(code: string): { title: string; body: string } {
  return (
    ERROR_MESSAGES[code] ?? {
      title: "초대 처리에 실패했어요",
      body: `잠시 후 다시 시도해주세요. (${code || "unknown"})`,
    }
  );
}

export function InviteAcceptView(props: {
  token: string;
  onAccepted: (workspaceId: string) => void | Promise<void>;
  onDismiss: (errorCode?: string) => void;
}) {
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [errorCode, setErrorCode] = useState<string>("");
  // 토큰은 마운트 시 한 번만 소비한다. React strict-mode 의 effect 더블 콜
  // 이나 부모 리렌더로 인한 재실행에서 같은 토큰이 두 번 POST 되지 않게
  // ref 로 가드한다. 서버도 중복 수락을 성공으로 취급하지만, 클라이언트가
  // 같은 토큰으로 불필요한 중복 POST 를 만들 이유는 없다.
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    let alive = true;
    let dismissTimer: number | null = null;
    void (async () => {
      try {
        const result = await acceptInvitation(props.token);
        if (!alive) return;
        clearPendingInviteToken();
        setStatus("ok");
        await props.onAccepted(result.workspaceId);
        if (!alive) return;
        dismissTimer = window.setTimeout(() => {
          props.onDismiss();
        }, 900);
      } catch (e) {
        if (!alive) return;
        const msg = (e as Error)?.message ?? "";
        if (!shouldPreserveInviteToken(msg)) clearPendingInviteToken();
        setErrorCode(msg);
        setStatus("error");
      }
    })();
    return () => {
      alive = false;
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
    };
  }, [props]);

  const error = status === "error" ? describe(errorCode) : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md rounded-2xl border-2 border-bd/10 bg-s1 p-6 text-t1 shadow-xl">
        {status === "working" ? (
          <>
            <h2 className="text-lg font-black tracking-tight">워크스페이스에 참여하는 중…</h2>
            <p className="mt-3 text-[12px] leading-relaxed text-t3">
              초대 토큰을 확인하고 멤버로 추가하고 있어요.
            </p>
          </>
        ) : status === "ok" ? (
          <>
            <h2 className="text-lg font-black tracking-tight text-ac">워크스페이스로 이동할게요</h2>
            <p className="mt-3 text-[12px] leading-relaxed text-t2">
              참여가 확인됐어요. 이미 멤버였던 경우에도 같은 워크스페이스로 바로 전환한 뒤 메인 화면으로 돌아갑니다.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => props.onDismiss()}
                className="rounded-xl border border-ac/40 bg-ac/15 px-3 py-2 text-[12px] font-bold text-ac transition hover:bg-ac/25"
              >
                바로 이동
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-black tracking-tight">{error?.title}</h2>
            <p className="mt-3 text-[12px] leading-relaxed text-t2">{error?.body}</p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => props.onDismiss(errorCode)}
                className="rounded-xl border border-bd/15 bg-s2 px-3 py-2 text-[12px] font-bold text-t2 transition hover:text-t1"
              >
                {actionLabel(errorCode)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
