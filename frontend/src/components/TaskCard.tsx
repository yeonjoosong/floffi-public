import { useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { BookmarkIcon } from "./BookmarkIcon";
import { ReportModal } from "./ReportModal";
import { hasMarker, toggleMarkerInList, MARKER_CATALOG } from "../lib/markers";
import type { AgentMember, BossReport, ProviderConfig, Task, Team } from "../lib/types";

function Tag(props: { children: ReactNode }) {
  return (
    <span data-role="tag" className="rounded-lg border border-bd/8 bg-s3 px-2 py-0.5 text-[11px] text-t2">
      {props.children}
    </span>
  );
}

function ExecBadge(props: { status: string }) {
  const map: Record<string, string> = {
    queued: "border-warn/35 bg-warn/10 text-warn",
    active: "border-ok/35 bg-ok/10 text-ok",
    retrying: "border-warn/50 bg-warn/15 text-warn",
    completed: "border-bd/10 bg-s3 text-t3",
  };
  const labels: Record<string, string> = {
    queued: "대기",
    active: "실행중",
    retrying: "재요청중",
    completed: "완료",
  };
  const pulse = props.status === "retrying";
  return (
    <span data-role="exec-badge" className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] font-black ${map[props.status] ?? map.completed}`}>
      {pulse ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" /> : null}
      {labels[props.status] ?? props.status}
    </span>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M 3 3 L 11 11 M 11 3 L 3 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function TaskCard(props: {
  task: Task;
  team?: Team;
  agent?: AgentMember;
  report?: BossReport;
  teamAgents: AgentMember[];
  providers: ProviderConfig[];
  onProviderModelChange: (providerId: string, model: string) => void;
  onToggleProvider: (providerId: string) => void;
  isDragging: boolean;
  spotlit?: boolean;
  onTouchDragBegin?: (e: ReactPointerEvent) => void;
  nativeDraggable?: boolean;
  onDelete: () => void;
  onUpdate: (patch: Partial<Task>) => void;
  onAddAttachment: (file: File) => Promise<void>;
  onRemoveAttachment: (attachmentId: string) => Promise<void>;
  onDragStart: () => void;
  onDragEnd: () => void;
  onStart: () => void;
  onComplete: () => void;
}) {
  const [taskOpen, setTaskOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const borderMap: Record<string, string> = {
    queued: "border-warn/30 bg-warn/5",
    active: "border-ok/30 bg-ok/5",
    retrying: "border-warn/40 bg-warn/8",
    completed: "border-bd/8 bg-s2/60",
  };
  const stop = (e: ReactMouseEvent) => e.stopPropagation();

  return (
    <article
      draggable={props.nativeDraggable !== false}
      data-role="task-card"
      data-exec-spotlight={props.spotlit ? props.task.executionStatus : undefined}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onPointerDown={props.onTouchDragBegin}
      onClick={() => setTaskOpen(true)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setTaskOpen(true);
        }
      }}
      style={{ touchAction: "none" }}
      className={[
        "cursor-pointer rounded-xl border p-3 transition hover:-translate-y-0.5 active:cursor-grabbing",
        "outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ac/60",
        borderMap[props.task.executionStatus] ?? "border-bd/10 bg-s2",
        props.isDragging ? "scale-95 opacity-50" : "",
        props.spotlit ? "ring-2 ring-ac/60 shadow-glow-sm -translate-y-0.5" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 title={props.task.title} className="text-sm font-bold leading-snug text-t1">{props.task.title}</h4>
        <div className="flex shrink-0 items-center gap-0.5">
          {(() => {
            const marked = hasMarker(props.task, "bookmark");
            return (
              <button
                data-role="icon-btn"
                data-variant="bookmark-toggle"
                type="button"
                onClick={(e) => {
                  stop(e);
                  props.onUpdate({ markers: toggleMarkerInList(props.task.markers, "bookmark") });
                }}
                aria-pressed={marked}
                aria-label={marked ? `${MARKER_CATALOG.bookmark.label} 해제` : `${MARKER_CATALOG.bookmark.label} 추가`}
                title={marked ? `${MARKER_CATALOG.bookmark.label} 해제` : `${MARKER_CATALOG.bookmark.label} 추가`}
                className={["rounded-lg p-1 transition", marked ? "text-ac" : "text-t3/60 hover:bg-s2 hover:text-t1"].join(" ")}
              >
                <BookmarkIcon active={marked} size={14} />
              </button>
            );
          })()}
          <button
            data-role="icon-btn"
            type="button"
            onClick={(e) => {
              stop(e);
              props.onDelete();
            }}
            className="rounded-lg p-1 text-t3 transition hover:bg-err/15 hover:text-err"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {props.task.description ? <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-t2">{props.task.description}</p> : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <ExecBadge status={props.task.executionStatus} />
        {props.task.workflowEnabled && props.task.workflowSteps.length > 0 ? (
          <span className="rounded-lg border border-ac/30 bg-ac/10 px-2 py-0.5 text-[10px] font-black text-ac">
            {props.task.workflowSteps[props.task.workflowStep]?.label ?? "?"} {props.task.workflowStep + 1}/{props.task.workflowSteps.length}
          </span>
        ) : null}
        {props.team ? <Tag>{props.team.name}</Tag> : null}
        {props.agent?.name || props.task.assignee ? <Tag>{props.agent?.name || props.task.assignee}</Tag> : null}
        {props.task.date ? <Tag>{props.task.date}</Tag> : null}
      </div>

      {props.report ? (
        <button type="button" onClick={(e) => { stop(e); setReportOpen(true); }} className="mt-2 w-full rounded-lg bg-ac/15 px-2 py-1.5 text-[11px] font-bold text-ac transition hover:bg-ac/25">
          보고서 전체 보기 →
        </button>
      ) : null}

      <div className="mt-2.5 flex gap-1.5" onClick={stop}>
        <button
          type="button"
          onClick={props.onStart}
          disabled={props.task.executionStatus === "active" || props.task.executionStatus === "retrying"}
          className="flex-1 rounded-lg border border-bd/10 bg-s3 py-1.5 text-[11px] font-bold text-t2 transition hover:bg-s2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {props.task.executionStatus === "active" ? "실행중…" : props.task.executionStatus === "completed" ? "재실행" : "시작"}
        </button>
        <button
          type="button"
          onClick={props.onComplete}
          disabled={props.task.executionStatus === "completed" || props.task.executionStatus === "retrying"}
          className="flex-1 rounded-lg border border-ok/35 bg-ok/10 py-1.5 text-[11px] font-bold text-ok transition hover:bg-ok/18 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {props.task.executionStatus === "retrying" ? "재요청중…" : "완료 + 보고"}
        </button>
      </div>

      {taskOpen ? (
        <ReportModal
          team={props.team}
          agent={props.agent}
          task={props.task}
          availableAgents={props.teamAgents}
          providers={props.providers}
          onProviderModelChange={props.onProviderModelChange}
          onToggleProvider={props.onToggleProvider}
          onAddAttachment={props.onAddAttachment}
          onRemoveAttachment={props.onRemoveAttachment}
          onRerun={props.onStart}
          onUpdate={props.onUpdate}
          onClose={() => setTaskOpen(false)}
        />
      ) : null}

      {reportOpen && props.report ? (
        <ReportModal
          report={props.report}
          team={props.team}
          agent={props.agent}
          task={props.task}
          onRerun={props.onStart}
          onClose={() => setReportOpen(false)}
        />
      ) : null}
    </article>
  );
}
