import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "../lib/escapeStack";
import { ModalCloseButton } from "./ModalCloseButton";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M 3 3 L 11 11 M 11 3 L 3 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SparkleIcon({ className, size = 30 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className}>
      <path d="M 13 3 Q 15.5 12 24.5 14 Q 15.5 16 13 25 Q 10.5 16 1.5 14 Q 10.5 12 13 3 Z" fill="currentColor" />
      <ellipse cx="13" cy="10.5" rx="1.4" ry="2.4" fill="white" opacity="0.65" />
      <path d="M 25 5 Q 26 8 29 9 Q 26 10 25 13 Q 24 10 21 9 Q 24 8 25 5 Z" fill="currentColor" opacity="0.85" />
      <circle cx="27" cy="20" r="1.4" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

export function ConfirmToast({
  open,
  title,
  message,
  confirmLabel = "확인",
  cancelLabel = "취소",
  variant = "default",
  icon,
  hideCancel = false,
  dismissOnBackdrop = true,
  extraAction,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  icon?: ReactNode;
  hideCancel?: boolean;
  dismissOnBackdrop?: boolean;
  extraAction?: { label: string; onClick: () => void };
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscapeClose(open, onCancel);

  if (!open) return null;

  const isDanger = variant === "danger";
  const ringColor = isDanger ? "ring-err/15" : "ring-ac/15";
  const borderColor = isDanger ? "border-err/45" : "border-ac/45";
  const iconColor = isDanger ? "text-err" : "text-ac";
  const confirmCls = isDanger
    ? "border-err/55 bg-err/15 text-err hover:bg-err/25"
    : "border-ac/55 bg-ac/15 text-ac hover:bg-ac/25";

  return createPortal(
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true">
      <div
        onClick={dismissOnBackdrop ? onCancel : undefined}
        className={`confirm-toast-backdrop absolute inset-0 bg-black/45 backdrop-blur-sm ${dismissOnBackdrop ? "" : "cursor-default"}`}
        aria-hidden
      />
      <div
        data-role="confirm-toast"
        data-variant={variant}
        className={[
          "confirm-toast absolute left-1/2 top-1/2 w-[min(92vw,360px)] -translate-x-1/2 -translate-y-1/2",
          "rounded-3xl border-2 bg-s1 p-5 shadow-2xl ring-4",
          borderColor,
          ringColor,
        ].join(" ")}
      >
        <div className={`mb-3 flex items-start justify-center gap-1 ${iconColor}`}>
          {icon ? <span className="confirm-toast-mascot block">{icon}</span> : null}
          <SparkleIcon className="confirm-toast-sparkle mt-1" />
        </div>
        <ModalCloseButton onClose={onCancel} className="absolute right-2 top-2" />
        <h3 className="text-center text-base font-black text-t1">
          {title}
          <button type="button" data-role="dialog-close-x" onClick={onCancel} aria-label="닫기">
            <CloseIcon />
          </button>
        </h3>
        <p className="mt-2 text-center text-sm leading-relaxed text-t2">{message}</p>
        {extraAction ? (
          <button
            type="button"
            onClick={extraAction.onClick}
            className="mt-4 w-full rounded-2xl border border-bd/15 bg-s2 px-4 py-2.5 text-sm font-bold text-t2 transition hover:bg-s3 hover:text-t1"
          >
            {extraAction.label}
          </button>
        ) : null}
        <div className="mt-3 flex gap-2">
          {hideCancel ? null : (
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-2xl border border-bd/15 bg-s2 px-4 py-3 text-sm font-bold text-t2 transition hover:bg-s3 hover:text-t1"
            >
              {cancelLabel}
            </button>
          )}
          <button type="button" onClick={onConfirm} autoFocus className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-bold transition ${confirmCls}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
