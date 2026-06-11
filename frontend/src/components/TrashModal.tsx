import { createPortal } from "react-dom";
import { useEscapeClose } from "../lib/escapeStack";
import { ModalCloseButton } from "./ModalCloseButton";
import type { Task } from "../lib/types";

const TRASH_RETENTION_DAYS = 7;

function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 3h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 12.5l6.5-6.5a3 3 0 114.2 4.2l-8.6 8.6a5 5 0 11-7.1-7.1l8.5-8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashModal(props: {
  tasks: Task[];
  onRestore: (taskId: string) => void;
  onPurge: (taskId: string) => void;
  onClose: () => void;
}) {
  useEscapeClose(true, props.onClose);

  const sorted = [...props.tasks].sort((a, b) =>
    (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""),
  );

  function daysRemaining(deletedAt: string): number {
    const d = new Date(deletedAt).getTime();
    if (Number.isNaN(d)) return TRASH_RETENTION_DAYS;
    const elapsed = (Date.now() - d) / (24 * 60 * 60 * 1000);
    return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsed));
  }

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <div onClick={props.onClose}
        className="confirm-toast-backdrop absolute inset-0 bg-black/45 backdrop-blur-sm" aria-hidden />
      <div data-role="modal-window"
        className="absolute left-1/2 top-1/2 max-h-[85vh] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border-2 border-bd/20 bg-s1 shadow-2xl">
        <ModalCloseButton onClose={props.onClose} />
        <div data-role="modal-titlebar" className="flex items-center justify-between border-b border-bd/10 px-5 py-3 pr-12">
          <h3 className="flex items-center gap-2 text-base font-black text-t1">
            <TrashIcon size={16} />
            <span>휴지통</span>
          </h3>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {sorted.length === 0 ? (
            <p className="py-8 text-center text-sm text-t3">휴지통이 비어 있습니다.</p>
          ) : (
            <>
              <p className="mb-3 text-[11px] text-t3">
                삭제한 태스크는 {TRASH_RETENTION_DAYS}일 동안 보관됩니다. 그 후 첨부파일과 함께 자동으로 영구 삭제됩니다.
              </p>
              <ul className="space-y-2">
                {sorted.map((t) => {
                  const left = t.deletedAt ? daysRemaining(t.deletedAt) : TRASH_RETENTION_DAYS;
                  return (
                    <li key={t.id} className="rounded-2xl border border-bd/10 bg-s2 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-t1">{t.title || "(제목 없음)"}</div>
                          {t.description ? (
                            <div className="mt-0.5 line-clamp-2 text-xs text-t3">{t.description}</div>
                          ) : null}
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-t3">
                            {t.deletedAt ? <span>삭제: {new Date(t.deletedAt).toLocaleString()}</span> : null}
                            <span>남은 보관: {left}일</span>
                            {t.attachments && t.attachments.length > 0 ? (
                              <span className="inline-flex items-center gap-1">
                                <ClipIcon />
                                <span>{t.attachments.length}</span>
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <button type="button" onClick={() => props.onRestore(t.id)}
                            className="rounded-lg border border-ac/40 bg-ac/10 px-2.5 py-1.5 text-xs font-bold text-ac transition hover:bg-ac/20">
                            복원
                          </button>
                          <button type="button" onClick={() => props.onPurge(t.id)}
                            className="rounded-lg border border-err/35 bg-err/10 px-2.5 py-1.5 text-xs font-bold text-err transition hover:bg-err/20">
                            영구삭제
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
