import type { IdleLogoutReason } from "../lib/idleTimer";
import { writeFreshActivityStamp } from "../lib/idleTimer";
import { ConfirmToast } from "./ConfirmToast";
import { IdleLogoutToast } from "./IdleLogoutToast";

type VerifyResult = { ok: boolean; message: string } | null;

type AppAuthenticatedOverlaysProps = {
  apiKeyMissingOpen: boolean;
  freeTierImageBlockedOpen: boolean;
  titleMissingOpen: boolean;
  resetBoardConfirmOpen: boolean;
  draftsRestoredOpen: boolean;
  verifyResult: VerifyResult;
  warnSeconds: number;
  onCloseApiKeyMissing: () => void;
  onCloseFreeTierImageBlocked: () => void;
  onCloseTitleMissing: () => void;
  onCloseDraftsRestored: () => void;
  onCloseVerifyResult: () => void;
  onCancelResetBoard: () => void;
  onConfirmResetBoard: () => void;
  onLogoutNow: (reason: IdleLogoutReason) => void;
  onWarnSecondsChange: (value: number) => void;
};

export function AppAuthenticatedOverlays(props: AppAuthenticatedOverlaysProps) {
  return (
    <>
      <ConfirmToast
        open={props.apiKeyMissingOpen}
        title="API 키가 없습니다"
        message="에이전트를 실행하려면 사이드바의 'API 키 (BYOK)' 섹션에서 API 키를 등록해주세요. 작성한 데이터는 그대로 유지됩니다."
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onCloseApiKeyMissing}
        onCancel={props.onCloseApiKeyMissing}
      />
      <ConfirmToast
        open={props.freeTierImageBlockedOpen}
        title="무료 모델은 이미지 생성 불가"
        message="이미지 생성 API는 무료 티어가 지원되지 않습니다. 사이드바에서 상위 모델로 변경하거나 '이미지 결과물 받기'를 해제해주세요."
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onCloseFreeTierImageBlocked}
        onCancel={props.onCloseFreeTierImageBlocked}
      />
      <ConfirmToast
        open={props.titleMissingOpen}
        title="태스크 제목이 비어있어요"
        message="태스크를 만들려면 먼저 제목을 입력해주세요."
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onCloseTitleMissing}
        onCancel={props.onCloseTitleMissing}
      />
      <ConfirmToast
        open={props.resetBoardConfirmOpen}
        title="보드를 초기화할까요?"
        message="모든 활성 태스크가 휴지통으로 이동합니다. 휴지통에서 7일 안에 복원할 수 있어요."
        confirmLabel="초기화"
        cancelLabel="취소"
        variant="danger"
        onConfirm={props.onConfirmResetBoard}
        onCancel={props.onCancelResetBoard}
      />
      <ConfirmToast
        open={props.draftsRestoredOpen}
        title="작성 중이던 내용을 복원했어요"
        message="이전 작성 내용을 복원했어요."
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onCloseDraftsRestored}
        onCancel={props.onCloseDraftsRestored}
      />
      <ConfirmToast
        open={!!props.verifyResult}
        title={props.verifyResult?.ok ? "이메일 인증" : "이메일 인증 실패"}
        message={props.verifyResult?.message ?? ""}
        confirmLabel="확인"
        hideCancel
        onConfirm={props.onCloseVerifyResult}
        onCancel={props.onCloseVerifyResult}
      />
      <IdleLogoutToast
        seconds={props.warnSeconds}
        onExtend={() => {
          writeFreshActivityStamp();
          props.onWarnSecondsChange(0);
        }}
        onLogoutNow={() => {
          props.onWarnSecondsChange(0);
          props.onLogoutNow("idle");
        }}
      />
    </>
  );
}
