import { useState, type ReactNode } from "react";
import { ReportModal } from "./ReportModal";
import { RelatedReportsModal } from "./RelatedReportsModal";
import { parseInline, renderMarkdown } from "./reportMarkdown";
import type { AgentMember, BossReport, Task, Team } from "../lib/types";

function formatDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function Card(props: { children: ReactNode; highlight?: boolean }) {
  return (
    <div className={[
      "rounded-2xl border border-bd/10 bg-s2/70 p-3 shadow-sm backdrop-blur-sm",
      props.highlight ? "ring-2 ring-ac/30" : "",
    ].join(" ")}>
      {props.children}
    </div>
  );
}

function Tag(props: { children: ReactNode }) {
  return (
    <span data-role="tag" className="rounded-lg border border-bd/8 bg-s3 px-2 py-0.5 text-[11px] text-t2">
      {props.children}
    </span>
  );
}

function MarkdownText({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{renderMarkdown(text)}</div>;
}

function ReportListIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={["inline-block", props.className ?? ""].join(" ")}>
      <path d="M5 2.5h5l2 2v7.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 5.5h3M6 7.5h4M6 9.5h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 4.5v8a1 1 0 0 0 1 1h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    </svg>
  );
}

function KBTrustBadge(props: { score?: number }) {
  const s = props.score ?? 0.5;
  if (s >= 0.7) return <span className="rounded-full bg-ac/15 px-2 py-0.5 text-[10px] font-bold text-ac">승인됨</span>;
  if (s <= 0.0) return <span className="rounded-full bg-err/15 px-2 py-0.5 text-[10px] font-bold text-err">부적합</span>;
  return <span className="rounded-full bg-s1 px-2 py-0.5 text-[10px] font-bold text-t3">미분류</span>;
}

export function ReportCard(props: {
  report: BossReport;
  team?: Team;
  agent?: AgentMember;
  task?: Task;
  taskMissing: boolean;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onRestore: () => void;
  onRerun?: () => void;
  relatedReports?: BossReport[];
  onApproveKB?: () => void;
  onDemoteKB?: () => void;
  onResetKB?: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const isDone = props.report.status === "approved" || props.report.status === "rejected";

  return (
    <Card highlight={props.report.status === "new"}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-snug text-t1">{parseInline(props.report.title)}</p>
          <p className="mt-0.5 text-[11px] text-ac/70">{formatDate(props.report.deliveredAt)}</p>
        </div>
        {isDone ? (
          <span
            data-role="status-badge"
            className={[
              "shrink-0 rounded-xl border px-2.5 py-1.5 text-[11px] font-bold",
              props.report.status === "approved" ? "border-bd/10 bg-s2 text-t3" : "border-ac-hi/40 bg-ac-hi/10 text-ac-hi",
            ].join(" ")}
          >
            {props.report.status === "approved" ? "승인됨" : "재요청됨"}
          </span>
        ) : (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => setRejecting((v) => !v)}
              className={[
                "rounded-xl border px-2.5 py-1.5 text-[11px] font-bold transition",
                rejecting ? "border-ac-hi/70 bg-ac-hi/20 text-ac-hi" : "border-ac-hi/45 bg-ac-hi/10 text-ac-hi hover:bg-ac-hi/18",
              ].join(" ")}
            >
              재요청
            </button>
            <button
              type="button"
              onClick={props.onApprove}
              className="rounded-xl border border-ac/40 bg-ac/10 px-2.5 py-1.5 text-[11px] font-bold text-ac transition hover:bg-ac/20"
            >
              승인
            </button>
          </div>
        )}
      </div>

      {expanded ? <ReportModal report={props.report} team={props.team} agent={props.agent} task={props.task} onRerun={props.onRerun} onClose={() => setExpanded(false)} /> : null}
      {historyOpen && props.relatedReports && props.relatedReports.length > 0 ? (
        <RelatedReportsModal taskTitle={props.task?.title ?? props.report.title} reports={props.relatedReports} onClose={() => setHistoryOpen(false)} />
      ) : null}

      {rejecting ? (
        <div className="mt-3 space-y-2">
          <textarea
            className="w-full resize-none rounded-xl border border-ac-hi/30 bg-ac-hi/5 px-3 py-2 text-xs text-t1 placeholder:text-t3 transition focus:border-ac-hi/50 focus:ring-2 focus:ring-ac-hi/15"
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="수정 방향이나 추가 지시사항을 입력하세요..."
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setRejecting(false);
                setFeedback("");
              }
            }}
          />
          <div className="flex gap-1.5">
            <button type="button" onClick={() => { setRejecting(false); setFeedback(""); }} className="flex-1 rounded-xl border border-bd/10 bg-s2 py-1.5 text-[11px] font-bold text-t3 transition hover:text-t1">취소</button>
            <button
              type="button"
              disabled={!feedback.trim()}
              onClick={() => {
                props.onReject(feedback.trim());
                setRejecting(false);
                setFeedback("");
              }}
              className="flex-1 rounded-xl border border-ac-hi/50 bg-ac-hi/10 py-1.5 text-[11px] font-bold text-ac-hi transition hover:bg-ac-hi/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              재요청 전송
            </button>
          </div>
        </div>
      ) : null}

      {props.report.feedback ? (
        <div className="mt-2 rounded-xl border border-ac-hi/20 bg-ac-hi/5 px-3 py-2">
          <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-ac-hi">피드백</p>
          <MarkdownText text={props.report.feedback} className="text-xs leading-relaxed text-t2" />
        </div>
      ) : null}

      {props.taskMissing && props.report.status === "rejected" ? (
        <div className="mt-2 rounded-xl border border-yellow-400/30 bg-yellow-400/8 px-3 py-2">
          <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-yellow-500">태스크 삭제됨</p>
          <p className="mb-2 text-[11px] leading-snug text-t2">이 보고서의 태스크가 보드에서 삭제되었습니다. 적절한 작업열로 복구한 뒤 다시 처리할 수 있습니다.</p>
          <button type="button" onClick={props.onRestore} className="rounded-xl border border-yellow-400/50 bg-yellow-400/15 px-3 py-1.5 text-[11px] font-bold text-yellow-600 transition hover:bg-yellow-400/25 dark:text-yellow-400">태스크 복구</button>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Tag>{props.team?.name || "팀 없음"}</Tag>
        <Tag>{props.agent?.name || "에이전트 없음"}</Tag>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" onClick={() => setExpanded(true)} className="flex-1 rounded-lg bg-ac/15 px-2 py-1.5 text-[11px] font-bold text-ac transition hover:bg-ac/25">보고서 전체 보기</button>
        {props.relatedReports && props.relatedReports.length > 0 ? (
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            aria-label={`이 태스크의 관련 보고서 ${props.relatedReports.length}건 보기`}
            title={`이 태스크의 관련 보고서 ${props.relatedReports.length}건`}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-bd/10 bg-s2 px-2 py-1.5 text-[11px] font-bold text-t2 transition hover:bg-s3 hover:text-t1"
          >
            <ReportListIcon size={13} />
            <span>{props.relatedReports.length}</span>
          </button>
        ) : null}
      </div>

      {props.onApproveKB ? (
        <div className="mt-2 rounded-xl border border-bd/10 bg-s2 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-t3">지식베이스</p>
            <KBTrustBadge score={props.report.trustScore} />
          </div>
          <p className="mt-1 text-[10px] leading-snug text-t3">승인된 리포트는 다음 작업의 에이전트 프롬프트에 자동 참조됩니다.</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" onClick={props.onApproveKB} className="rounded-lg border border-ac/40 bg-ac/10 px-2 py-1 text-[10px] font-bold text-ac transition hover:bg-ac/20">승인</button>
            <button type="button" onClick={props.onDemoteKB} className="rounded-lg border border-err/30 bg-err/8 px-2 py-1 text-[10px] font-bold text-err transition hover:bg-err/15">부적합</button>
            <button type="button" onClick={props.onResetKB} className="rounded-lg border border-bd/15 bg-s1 px-2 py-1 text-[10px] font-bold text-t2 transition hover:text-t1">초기화</button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
