import { createPortal } from "react-dom";
import { useEscapeClose } from "../lib/escapeStack";

// IdleLogoutToast — countdown overlay shown when the idle watcher fires its
// "soft idle" warning. The watcher (lib/idleTimer.ts) drives `seconds`; this
// component only renders. seconds <= 0 means "no warning" and the component
// returns null.
//
// Style mirrors ConfirmToast so the user reads it the same way. z-[75] sits
// just below ConfirmToast (z-[80]) so an in-flight confirmation (e.g. boss
// approve) still overlays it without arguing about pointer-events.

export function IdleLogoutToast(props: {
  seconds: number;
  onExtend: () => void;
  onLogoutNow: () => void;
}) {
  // ESC keeps the session alive — same semantics as the backdrop
  // click + the "유지하기" button. Project-wide rule: every modal
  // dismisses on ESC; for the idle warning the safe default is
  // "extend," not "logout now," since accidentally pressing ESC
  // shouldn't be enough to log the user out.
  const visible = Number.isFinite(props.seconds) && props.seconds > 0;
  useEscapeClose(visible, props.onExtend);
  if (!visible) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[75]"
      role="alertdialog"
      aria-live="assertive"
      aria-modal="true"
    >
      {/* backdrop — clickable to extend, same affordance as the primary button */}
      <div
        onClick={props.onExtend}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-hidden
      />
      <div
        className="absolute left-1/2 top-1/2 w-[min(92vw,360px)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border-2 border-ac/45 bg-s1 p-5 shadow-2xl ring-4 ring-ac/15"
      >
        <h3 className="text-center text-base font-black text-t1">
          곧 자동 로그아웃 됩니다
        </h3>
        <p className="mt-2 text-center text-sm leading-relaxed text-t2">
          {props.seconds}초 후 자동 로그아웃 됩니다. 활동이 감지되면 자동 연장됩니다.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={props.onLogoutNow}
            className="flex-1 rounded-2xl border border-bd/15 bg-s2 px-4 py-3 text-sm font-bold text-t2 transition hover:bg-s3 hover:text-t1"
          >
            지금 로그아웃
          </button>
          <button
            type="button"
            onClick={props.onExtend}
            autoFocus
            className="flex-1 rounded-2xl border border-ac/55 bg-ac/15 px-4 py-3 text-sm font-bold text-ac transition hover:bg-ac/25"
          >
            유지하기
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
