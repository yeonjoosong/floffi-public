import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useEscapeClose } from "../lib/escapeStack";
import { ModalCloseButton } from "./ModalCloseButton";
import { parseInline, renderMarkdown } from "./reportMarkdown";
import type { BossReport } from "../lib/types";

type RelatedReportsModalProps = {
  taskTitle: string;
  reports: BossReport[];
  onClose: () => void;
};

function formatDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function UpArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M 5 13 L 10 7 L 15 13" stroke="currentColor" strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RelatedReportsModal(props: RelatedReportsModalProps) {
  const sorted = [...props.reports].sort(
    (a, b) => new Date(b.deliveredAt).getTime() - new Date(a.deliveredAt).getTime(),
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => setShowScrollTop(el.scrollTop > 200);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = () => listRef.current?.scrollTo({ top: 0, behavior: "smooth" });

  useEscapeClose(true, props.onClose);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      role="dialog" aria-modal="true"
    >
      <div
        data-role="modal-window"
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-bd/15 bg-s1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div data-role="modal-titlebar" className="relative flex shrink-0 items-start gap-3 rounded-t-2xl border-b border-bd/10 bg-s1 px-6 py-4 pr-12">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-black uppercase tracking-wider text-t3">관련 보고서</p>
            <p className="mt-0.5 truncate text-base font-black text-t1">{props.taskTitle}</p>
            <p className="mt-0.5 text-xs text-t3">이 태스크에 연결된 다른 보고서 {sorted.length}건</p>
          </div>
          <ModalCloseButton onClose={props.onClose} />
        </div>

        <ul ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {sorted.map((r) => {
            const isOpen = expandedIds.has(r.id);
            const statusLabel =
              r.status === "approved" ? "승인됨" :
              r.status === "rejected" ? "재요청됨" : "검토 중";
            return (
              <li key={r.id} className="rounded-xl border border-bd/10 bg-s2/60">
                <button type="button" data-role="row-btn"
                  onClick={() => setExpandedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
                    return next;
                  })}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-bold text-t1">{parseInline(r.title)}</p>
                    <p className="text-[11px] text-t3">{formatDate(r.deliveredAt)}</p>
                  </div>
                  <span data-role="status-badge"
                    className="shrink-0 rounded-md border border-bd/15 bg-s1 px-1.5 py-0.5 text-[10px] font-bold text-t2">
                    {statusLabel}
                  </span>
                  <svg className={`h-3 w-3 shrink-0 text-t3 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <path d="M6 8L1 3h10z" />
                  </svg>
                </button>
                {isOpen ? (
                  <div className="border-t border-bd/10 px-3 py-3 text-[12px] leading-relaxed text-t1">
                    {renderMarkdown(r.summary)}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {showScrollTop ? (
          <button type="button" onClick={scrollToTop} data-role="scroll-top"
            aria-label="맨 위로 가기" title="맨 위로"
            className="absolute bottom-5 right-5 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-ac text-white shadow-lg transition hover:scale-110 hover:bg-ac-hi">
            <UpArrowIcon />
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
