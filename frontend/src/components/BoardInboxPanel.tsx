import { isActiveWorkspaceOwner } from "../lib/workspaces";
import type { AgentMember, BossReport, Task, Team } from "../lib/types";
import { EmptyMsg } from "./BoardViewPrimitives";
import { ReportCard } from "./ReportCard";
import { WorkspaceSearchBar } from "./WorkspaceSearchBar";

type InboxTimeRange = "1h" | "2h" | "business" | "today" | "3d" | "7d" | "all";
type InboxStatusFilter = "all" | "new" | "approved" | "rejected";

export interface InboxFilter {
  timeRange: InboxTimeRange;
  maxCount: number;
  status: InboxStatusFilter;
}

type BoardInboxPanelProps = {
  bossReports: BossReport[];
  teams: Team[];
  teamMembers: AgentMember[];
  tasks: Task[];
  inboxFilter: InboxFilter;
  inboxFilterOpen: boolean;
  onToggleFilterOpen: () => void;
  onInboxFilterChange: (next: InboxFilter) => void;
  onClearInboxOpen: () => void;
  onApproveReport: (reportId: string) => void;
  onRejectReport: (reportId: string, feedback: string) => void;
  onRestoreTask: (reportId: string) => void;
  onStartTask: (taskId: string, status: Task["executionStatus"]) => void;
  onApproveKBReport: (reportId: string) => void;
  onDemoteKBReport: (reportId: string) => void;
  onResetKBReport: (reportId: string) => void;
};

function filterReports(reports: BossReport[], filter: InboxFilter): BossReport[] {
  const now = new Date();
  let filtered = reports.filter((report) => {
    if (filter.status === "new" && report.status !== "new") return false;
    if (filter.status === "approved" && report.status !== "approved") return false;
    if (filter.status === "rejected" && report.status !== "rejected") return false;

    const delivered = new Date(report.deliveredAt);
    if (filter.timeRange === "1h") return now.getTime() - delivered.getTime() <= 60 * 60 * 1000;
    if (filter.timeRange === "2h") return now.getTime() - delivered.getTime() <= 2 * 60 * 60 * 1000;
    if (filter.timeRange === "today") return delivered.toDateString() === now.toDateString();
    if (filter.timeRange === "3d") return now.getTime() - delivered.getTime() <= 3 * 24 * 60 * 60 * 1000;
    if (filter.timeRange === "7d") return now.getTime() - delivered.getTime() <= 7 * 24 * 60 * 60 * 1000;
    if (filter.timeRange === "business") {
      if (delivered.toDateString() !== now.toDateString()) return false;
      const hour = delivered.getHours();
      return hour >= 9 && hour < 18;
    }
    return true;
  });
  if (filter.maxCount > 0) filtered = filtered.slice(0, filter.maxCount);
  return filtered;
}

export function BoardInboxPanel(props: BoardInboxPanelProps) {
  const visible = filterReports(props.bossReports, props.inboxFilter);

  return (
    <>
      <WorkspaceSearchBar />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={props.onClearInboxOpen}
          className="rounded-xl border border-err/25 bg-err/8 px-3 py-1.5 text-[11px] font-bold text-err transition hover:bg-err/15"
        >
          받은함 비우기
        </button>
      </div>
      <div className="rounded-xl border border-bd/10 bg-s2">
        <button
          type="button"
          data-role="row-btn"
          onClick={props.onToggleFilterOpen}
          className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-bold text-t2 transition hover:text-t1"
        >
          <span>필터</span>
          <span className="flex items-center gap-1.5 text-t3">
            {props.inboxFilter.timeRange !== "all" ? (
              <span className="rounded-full bg-ac/15 px-2 py-0.5 text-[10px] text-ac">
                {{ "1h": "1시간", "2h": "2시간", business: "업무시간", today: "오늘", "3d": "3일", "7d": "7일" }[props.inboxFilter.timeRange]}
              </span>
            ) : null}
            {props.inboxFilter.status !== "all" ? (
              <span className="rounded-full bg-ac/15 px-2 py-0.5 text-[10px] text-ac">
                {{ new: "대기", approved: "승인", rejected: "재요청" }[props.inboxFilter.status]}
              </span>
            ) : null}
            {props.inboxFilter.maxCount > 0 ? (
              <span className="rounded-full bg-ac/15 px-2 py-0.5 text-[10px] text-ac">최대 {props.inboxFilter.maxCount}개</span>
            ) : null}
            <svg className={`h-3 w-3 transition-transform ${props.inboxFilterOpen ? "rotate-180" : ""}`} viewBox="0 0 12 12" fill="currentColor"><path d="M6 8L1 3h10z" /></svg>
          </span>
        </button>
        {props.inboxFilterOpen ? (
          <div className="space-y-3 border-t border-bd/10 px-3 pb-3 pt-2">
            <div>
              <p className="mb-1.5 text-[10px] text-t3">기간</p>
              <div className="flex flex-wrap gap-1">
                {(["all", "1h", "2h", "business", "today", "3d", "7d"] as InboxTimeRange[]).map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => props.onInboxFilterChange({ ...props.inboxFilter, timeRange: range })}
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold transition ${
                      props.inboxFilter.timeRange === range ? "bg-ac text-white" : "bg-s3 text-t2 hover:bg-ac/15 hover:text-ac"
                    }`}
                  >
                    {{ all: "전체", "1h": "1시간", "2h": "2시간", business: "업무(9-18)", today: "오늘", "3d": "3일", "7d": "7일" }[range]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[10px] text-t3">상태</p>
              <div className="flex gap-1">
                {(["all", "new", "approved", "rejected"] as InboxStatusFilter[]).map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => props.onInboxFilterChange({ ...props.inboxFilter, status })}
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold transition ${
                      props.inboxFilter.status === status ? "bg-ac text-white" : "bg-s3 text-t2 hover:bg-ac/15 hover:text-ac"
                    }`}
                  >
                    {{ all: "전체", new: "대기", approved: "승인", rejected: "재요청" }[status]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[10px] text-t3">최대 표시 수</p>
                <span className="text-[10px] font-bold text-ac">
                  {props.inboxFilter.maxCount === 0 ? "제한 없음" : `${props.inboxFilter.maxCount}개`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={props.inboxFilter.maxCount}
                  onChange={(e) => props.onInboxFilterChange({ ...props.inboxFilter, maxCount: parseInt(e.target.value) })}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-s3 accent-[rgb(var(--ac))]"
                />
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={props.inboxFilter.maxCount === 0 ? "" : props.inboxFilter.maxCount}
                  placeholder="∞"
                  onChange={(e) => props.onInboxFilterChange({ ...props.inboxFilter, maxCount: Math.max(0, parseInt(e.target.value) || 0) })}
                  className="w-14 rounded-lg border border-bd/15 bg-s1 px-2 py-0.5 text-center text-[11px] text-t1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyMsg>조건에 맞는 보고서가 없습니다.</EmptyMsg>
      ) : visible.map((report) => {
        const team = props.teams.find((item) => item.id === report.teamId);
        const agent = props.teamMembers.find((item) => item.id === report.agentId);
        const task = props.tasks.find((item) => item.id === report.taskId);
        const relatedReports = task
          ? props.bossReports.filter((item) => item.taskId === task.id && item.id !== report.id)
          : [];
        return (
          <ReportCard
            key={report.id}
            report={report}
            team={team}
            agent={agent}
            task={task}
            taskMissing={!task}
            onApprove={() => props.onApproveReport(report.id)}
            onReject={(feedback) => props.onRejectReport(report.id, feedback)}
            onRestore={() => props.onRestoreTask(report.id)}
            onRerun={task ? () => props.onStartTask(task.id, "active") : undefined}
            relatedReports={relatedReports}
            onApproveKB={isActiveWorkspaceOwner() ? () => props.onApproveKBReport(report.id) : undefined}
            onDemoteKB={isActiveWorkspaceOwner() ? () => props.onDemoteKBReport(report.id) : undefined}
            onResetKB={isActiveWorkspaceOwner() ? () => props.onResetKBReport(report.id) : undefined}
          />
        );
      })}
    </>
  );
}
