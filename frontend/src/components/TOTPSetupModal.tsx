import { useEffect, useState } from "react";
import { enableTOTP, setupTOTP } from "../lib/auth";
import { ModalCloseButton } from "./ModalCloseButton";
import { useEscapeClose } from "../lib/escapeStack";

// TOTPSetupModal — the first-time enrollment flow. Two screens:
//   1) QR / secret + 6-digit input → POST /totp/enable
//   2) Recovery codes display + "saved it" confirmation
//
// Codes are only shown once; if the user closes the modal mid-step-2
// without clicking "확인" they lose access to them.

type TOTPSetupModalProps = {
  open: boolean;
  onClose: () => void;
  onEnabled: () => void;
};

export function TOTPSetupModal(props: TOTPSetupModalProps) {
  const [step, setStep] = useState<"qr" | "codes">("qr");
  const [setupResp, setSetupResp] = useState<{ otpauthURI: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!props.open) return;
    setStep("qr");
    setCode("");
    setCodes([]);
    setError("");
    setBusy(true);
    void (async () => {
      try {
        const r = await setupTOTP();
        setSetupResp(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "설정 정보를 가져오지 못했어요.");
      } finally {
        setBusy(false);
      }
    })();
  }, [props.open]);

  async function handleEnable() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const c = await enableTOTP(code.trim());
      setCodes(c);
      setStep("codes");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("invalid_code")) {
        setError("코드가 일치하지 않아요. 다시 입력해주세요.");
      } else {
        setError("활성화에 실패했어요. 잠시 후 다시 시도해주세요.");
      }
    } finally {
      setBusy(false);
    }
  }

  function downloadCodes() {
    const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "floffi-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ESC closes; component unmount + the open-effect above wipes the
  // entered code / fetched secret so the user can't accidentally
  // resume a half-typed enrollment on next open.
  useEscapeClose(props.open, props.onClose);

  if (!props.open) return null;

  return (
    // Backdrop click DOES NOT close — the user has a 6-digit code typed
    // in and a one-shot secret fetched from the server; an accidental
    // click outside the card would lose both. Use the X or ESC.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      {/* Outer card has NO padding — the titlebar must sit flush with
          the card's top edge so the win98 navy bar aligns to the
          dialog frame. Body wraps in its own padded div, matching the
          structure of ReportModal / PlaygroundModal / UserInfoModal. */}
      <div data-role="modal-window" className="relative w-full max-w-md rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
        {step === "qr" ? (
          <>
            {/* Flex titlebar — h2 + X live on the same row, vertically
                centered by items-center. We drop the absolute
                positioning on the close button (passing className=
                "relative" overrides the component's default
                `absolute right-3 top-3`) so flex can lay it out
                naturally next to the heading. */}
            <div data-role="modal-titlebar" className="flex items-center justify-between gap-3 rounded-t-2xl border-b border-bd/10 px-6 py-4">
              <h2 className="text-lg font-black tracking-tight">2단계 인증 설정</h2>
              {/* Visual fine-tune: 5px down (4px from initial nudge
                  + 1px), 2px left from flex's right edge so the X
                  doesn't hug the corner. Both axes via transform
                  so flex centering math doesn't absorb them. */}
              <ModalCloseButton onClose={props.onClose} className="translate-y-[5px] -translate-x-0.5" />
            </div>
            <div className="px-6 py-5">
            <p className="text-sm text-t3">
              Google Authenticator / Authy / 1Password 같은 인증 앱에 다음 URI를 등록한 뒤
              앱이 표시하는 6자리 코드를 입력해주세요.
            </p>
            {setupResp ? (
              <>
                {/* URI + Secret each adopt the same label-above /
                    inset-box pattern as the "인증 앱이 표시하는 6자리
                    코드" input below: small uppercase label outside,
                    then a border-2 / bg-s2 box that reads as a
                    recessed field rather than a raised card. Copy
                    button stays at the bottom-right of the box. */}
                <label className="mt-4 block text-[11px] font-black uppercase tracking-wider text-t3">
                  otpauth URI
                </label>
                <div data-role="modal-field" className="mt-1 rounded-md border-2 border-bd/10 bg-s2 px-4 py-3">
                  <p className="break-all font-mono text-xs text-t1">{setupResp.otpauthURI}</p>
                  <button
                    type="button"
                    onClick={() => { void navigator.clipboard.writeText(setupResp.otpauthURI); }}
                    className="mt-2 rounded-md border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t2 hover:bg-s3"
                  >
                    URI 복사
                  </button>
                </div>

                <label className="mt-4 block text-[11px] font-black uppercase tracking-wider text-t3">
                  직접 입력
                </label>
                <div data-role="modal-field" className="mt-1 rounded-md border-2 border-bd/10 bg-s2 px-4 py-3">
                  {/* break-all + tracking-wider — a 32-char base32
                      secret with font-mono used to spill past the
                      card's right edge. break-all wraps on any
                      character, tracking-wider keeps glyph widths
                      sensible. */}
                  <p className="break-all font-mono text-sm tracking-wider text-t1">{setupResp.secret}</p>
                  <button
                    type="button"
                    onClick={() => { void navigator.clipboard.writeText(setupResp.secret); }}
                    className="mt-2 rounded-md border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t2 hover:bg-s3"
                  >
                    Secret 복사
                  </button>
                </div>
              </>
            ) : (
              <p className="mt-4 text-sm text-t3">설정 정보를 불러오는 중...</p>
            )}

            <label className="mt-5 block text-[11px] font-black uppercase tracking-wider text-t3">
              인증 앱이 표시하는 6자리 코드
            </label>
            <input
              type="text"
              inputMode="numeric"
              className="mt-1 w-full rounded-md border-2 border-bd/10 bg-s2 px-4 py-3 text-center font-mono text-lg tracking-widest text-t1 outline-none focus:outline-none"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleEnable(); }}
              placeholder="123 456"
            />

            {error ? (
              <p className="mt-3 rounded-xl border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-300">{error}</p>
            ) : null}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={props.onClose}
                className="flex-1 rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2.5 text-sm font-bold text-t2 outline-none transition focus:outline-none"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleEnable()}
                disabled={busy || !code.trim()}
                className="flex-1 rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2.5 text-sm font-black text-white outline-none transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "확인 중..." : "활성화"}
              </button>
            </div>
            </div>
          </>
        ) : (
          <>
            <div data-role="modal-titlebar" className="flex items-center justify-between gap-3 rounded-t-2xl border-b border-bd/10 px-6 py-4">
              <h2 className="text-lg font-black tracking-tight">복구 코드</h2>
              {/* Visual fine-tune: 5px down (4px from initial nudge
                  + 1px), 2px left from flex's right edge so the X
                  doesn't hug the corner. Both axes via transform
                  so flex centering math doesn't absorb them. */}
              <ModalCloseButton onClose={props.onClose} className="translate-y-[5px] -translate-x-0.5" />
            </div>
            <div className="px-6 py-5">
            <p className="text-sm text-t3">
              아래 10개의 복구 코드는 인증 앱에 접근할 수 없을 때 사용합니다.
              지금 안전한 곳에 저장해주세요 — 다시 보여드릴 수 없습니다.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-bd/10 bg-s2 p-3">
              {codes.map((c) => (
                <p key={c} className="text-center font-mono text-sm tracking-wider text-t1">{c}</p>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={downloadCodes}
                className="flex-1 rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2.5 text-sm font-bold text-t2 outline-none transition focus:outline-none"
              >
                다운로드
              </button>
              <button
                type="button"
                onClick={() => { props.onEnabled(); props.onClose(); }}
                className="flex-1 rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2.5 text-sm font-black text-white outline-none transition focus:outline-none"
              >
                저장했어요
              </button>
            </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
