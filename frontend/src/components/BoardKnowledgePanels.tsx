import { useEffect, useRef, useState } from "react";
import type { SessionHistoryItem, VaultDocument } from "../lib/types";
import { BookIcon, RunbookBookModal } from "./RunbookBookModal";
import { Card, DangerBtn, EmptyMsg, FInput, FTextarea, PrimaryBtn } from "./BoardViewPrimitives";

type BoardVaultPanelProps = {
  vaultSearchQuery: string;
  vaultSearchResults: VaultDocument[];
  vaultSearchLoading: boolean;
  newVaultTitle: string;
  newVaultNote: string;
  vaultDocs: VaultDocument[];
  onVaultSearchQueryChange: (value: string) => void;
  onNewVaultTitleChange: (value: string) => void;
  onNewVaultNoteChange: (value: string) => void;
  onAddVaultDoc: () => void;
  onRemoveVaultDoc: (docId: string) => void;
};

type BoardHistoryPanelProps = {
  sessions: SessionHistoryItem[];
};

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="inline-block">
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function formatDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function VaultDocCard(props: { doc: { id: string; title: string; note: string }; onRemove?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const hasNote = !!props.doc.note;
  const isRunbook = /runbook|런북/i.test(props.doc.title);

  useEffect(() => {
    const element = noteRef.current;
    if (element) setClamped(element.scrollHeight > element.clientHeight);
  }, [props.doc.note]);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-t1">{props.doc.title}</p>
          {hasNote ? (
            <>
              <p ref={noteRef} className={["mt-0.5 whitespace-pre-wrap text-xs text-t2", expanded && !isRunbook ? "" : "line-clamp-2"].join(" ")}>
                {props.doc.note}
              </p>
              {isRunbook ? (
                <button
                  type="button"
                  className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-ac/15 px-2 py-0.5 text-[11px] font-bold text-ac transition hover:bg-ac/25"
                  onClick={() => setBookOpen(true)}
                >
                  <BookIcon size={12} className="shrink-0" />
                  <span>펼쳐보기</span>
                </button>
              ) : (clamped || expanded) ? (
                <button
                  type="button"
                  className="mt-1.5 rounded-lg bg-ac/15 px-2 py-0.5 text-[11px] font-bold text-ac transition hover:bg-ac/25"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? "접기 ↑" : "펼치기 ↓"}
                </button>
              ) : null}
            </>
          ) : (
            <p className="mt-0.5 text-xs text-t3">메모 없음</p>
          )}
        </div>
        {props.onRemove ? <DangerBtn onClick={props.onRemove}>삭제</DangerBtn> : null}
      </div>
      {bookOpen ? <RunbookBookModal title={props.doc.title} note={props.doc.note} onClose={() => setBookOpen(false)} /> : null}
    </Card>
  );
}

export function BoardVaultPanel(props: BoardVaultPanelProps) {
  return (
    <>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-t3">
          <SearchIcon />
        </span>
        <input
          className="w-full rounded-xl border border-bd/10 bg-s2 py-2.5 pl-9 pr-4 text-sm text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
          value={props.vaultSearchQuery}
          onChange={(e) => props.onVaultSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              props.onVaultSearchQueryChange("");
              e.currentTarget.blur();
            }
          }}
          placeholder="보관함 검색..."
        />
      </div>

      <div className="space-y-2">
        {props.vaultSearchLoading ? (
          <EmptyMsg>검색 중...</EmptyMsg>
        ) : props.vaultSearchResults.length === 0 ? (
          <EmptyMsg>일치하는 문서가 없습니다.</EmptyMsg>
        ) : (
          props.vaultSearchResults.slice(0, 4).map((doc) => <VaultDocCard key={doc.id} doc={doc} />)
        )}
      </div>

      <div className="border-t border-bd/8 pt-4">
        <p className="mb-3 text-[11px] font-black uppercase tracking-wider text-t3">문서 추가</p>
        <div className="space-y-2">
          <FInput value={props.newVaultTitle} onChange={props.onNewVaultTitleChange} placeholder="문서 제목" onSubmit={props.onAddVaultDoc} />
          <FTextarea
            value={props.newVaultNote}
            onChange={props.onNewVaultNoteChange}
            placeholder="메모 (선택)"
            rows={2}
            onCancel={() => {
              props.onNewVaultTitleChange("");
              props.onNewVaultNoteChange("");
            }}
          />
          <PrimaryBtn onClick={props.onAddVaultDoc} full>+ 문서 추가</PrimaryBtn>
        </div>

        {props.vaultDocs.length > 0 ? (
          <div className="mt-4 space-y-2">
            <p className="text-[11px] font-black uppercase tracking-wider text-t3">저장된 문서 · {props.vaultDocs.length}개</p>
            {props.vaultDocs.slice(0, 3).map((doc) => (
              <VaultDocCard key={doc.id} doc={doc} onRemove={() => props.onRemoveVaultDoc(doc.id)} />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function BoardHistoryPanel(props: BoardHistoryPanelProps) {
  return props.sessions.length === 0 ? (
    <EmptyMsg>아직 활동 기록이 없습니다.</EmptyMsg>
  ) : (
    <>
      {props.sessions.slice(0, 8).map((session) => (
        <Card key={session.id}>
          <p className="text-sm font-bold text-t1">{session.title}</p>
          <p className="mt-0.5 text-[11px] text-ac/70">{formatDate(session.updatedAt)}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-t2">{session.summary}</p>
        </Card>
      ))}
    </>
  );
}
