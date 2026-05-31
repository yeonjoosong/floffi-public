import { AttachmentPicker, FDateInput, FField, FInput, FSelect, FTextarea, PrimaryBtn } from "./BoardViewPrimitives";
import type { AgentMember, ProviderConfig, Section, Team } from "../lib/types";

type BoardQuickAssignPanelProps = {
  assignOpen: boolean;
  title: string;
  description: string;
  pendingFiles: File[];
  imageOutput: boolean;
  imageGridCount: number;
  taskTeamId: string;
  taskAgentId: string;
  status: string;
  assignee: string;
  date: string;
  providers: ProviderConfig[];
  teams: Team[];
  sections: Section[];
  candidateAgents: AgentMember[];
  onToggleOpen: () => void;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onPendingFilesChange: (files: File[]) => void;
  onImageOutputChange: (value: boolean) => void;
  onImageGridCountChange: (value: number) => void;
  onTaskTeamIdChange: (value: string) => void;
  onTaskAgentIdChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onAssigneeChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onCreateTask: () => void;
  onCreateWorkflowTask: () => void;
};

const WORKFLOW_AGENT_IDS = ["planner", "builder", "executor", "analyst", "summarizer"];

function ChevronIcon(props: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`inline-block transition-transform ${props.open ? "rotate-180" : ""}`}>
      <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BoardQuickAssignPanel(props: BoardQuickAssignPanelProps) {
  const picked = props.candidateAgents.find((member) => member.id === props.taskAgentId);
  const showWorkflowHint = !!picked && WORKFLOW_AGENT_IDS.includes(picked.id);

  return (
    <div data-role="quick-assign" className="shrink-0 border-b border-bd/10 bg-s1">
      <button type="button" data-role="row-btn" onClick={props.onToggleOpen} className="flex h-12 w-full items-center gap-3 px-5 text-sm transition hover:bg-s2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ac/15 text-xs font-black text-ac">+</span>
        <span className="font-bold text-t1">태스크 빠른 배정</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-t3">
          <span>{props.providers.filter((provider) => provider.enabled).length}개 활성 프로바이더</span>
          <ChevronIcon open={props.assignOpen} />
        </span>
      </button>

      {props.assignOpen ? (
        <div className="border-t border-bd/8 px-5 pb-5 pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div className="rounded-xl border border-bd/10 bg-s2 px-3 py-3 text-[12px] leading-relaxed text-t2">
                <p className="font-bold text-t1">빠른 시작</p>
                <p className="mt-1">
                  1. 제목과 설명 입력
                  <br />
                  2. 단건이면 <b>태스크 배정</b>, 여러 단계면 <b>+ 워크플로</b>
                  <br />
                  3. 결과는 <b>받은함</b>에서 검토 후 승인 또는 복구
                </p>
              </div>
              <FField label="태스크 제목">
                <FInput value={props.title} onChange={props.onTitleChange} placeholder="무엇을 해야 하나요?" onSubmit={props.onCreateTask} />
              </FField>
              <FField label="설명">
                <FTextarea value={props.description} onChange={props.onDescriptionChange} placeholder="자세한 내용" rows={3} />
              </FField>
              <FField label="첨부 파일 (선택)">
                <AttachmentPicker files={props.pendingFiles} onChange={props.onPendingFilesChange} />
              </FField>
              <div data-role="form-panel" className="rounded-xl border border-bd/10 bg-s2 p-2.5 text-xs text-t2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={props.imageOutput}
                    onChange={(e) => props.onImageOutputChange(e.target.checked)}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-ac"
                  />
                  <span className="font-bold text-t1">이미지</span>
                  <select
                    id="image-grid-count"
                    aria-label="이미지 개수와 배치"
                    disabled={!props.imageOutput}
                    value={props.imageGridCount}
                    onChange={(e) => props.onImageGridCountChange(Number(e.target.value))}
                    className="select-compact cursor-pointer rounded-lg border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t1 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value={1}>1 (1x1)</option>
                    <option value={4}>4 (2x2)</option>
                    <option value={6}>6 (2x3)</option>
                    <option value={9}>9 (3x3)</option>
                    <option value={10}>10 (5x2)</option>
                    <option value={12}>12 (3x4)</option>
                  </select>
                </div>
                <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-t3">
                  이미지 작업이 포함된 경우 완료 보고서에 이미지가 첨부됩니다. <span className="whitespace-nowrap">(Gemini 전용)</span>
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FField label="팀">
                  <FSelect value={props.taskTeamId} onChange={props.onTaskTeamIdChange} options={props.teams.map((team) => ({ value: team.id, label: team.name }))} placeholder="팀 선택" />
                </FField>
                <FField label="에이전트">
                  <FSelect value={props.taskAgentId} onChange={props.onTaskAgentIdChange} options={props.candidateAgents.map((member) => ({ value: member.id, label: member.name }))} placeholder="선택" />
                </FField>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <FField label="섹션">
                  <FSelect value={props.status} onChange={props.onStatusChange} options={props.sections.map((section) => ({ value: section.id, label: section.title }))} placeholder="섹션" />
                </FField>
                <FField label="담당자">
                  <FInput value={props.assignee} onChange={props.onAssigneeChange} placeholder="담당자" onSubmit={props.onCreateTask} />
                </FField>
                <FField label="날짜">
                  <FDateInput value={props.date} onChange={props.onDateChange} />
                </FField>
              </div>
              {showWorkflowHint ? (
                <div className="rounded-lg border border-ac/30 bg-ac/5 px-3 py-2 text-[12px] text-t2">
                  <span className="font-bold text-ac">안내</span> · {picked.name}는 워크플로 단계 에이전트입니다.
                  단독 배정 시 1회 실행 후 Done으로 이동하고 더 이상 진행되지 않습니다. 다음 단계가 필요하면
                  모달에서 담당 에이전트를 변경 후 <b>재실행</b>하거나, 처음부터 <b>+ 워크플로</b>로 배정하세요.
                </div>
              ) : null}
              <div className="flex gap-2">
                <PrimaryBtn onClick={props.onCreateTask} full size="lg">태스크 배정</PrimaryBtn>
                <button
                  type="button"
                  onClick={props.onCreateWorkflowTask}
                  title="Planner → Builder → Executor → Analyst → Summarizer 5단계 워크플로로 배정"
                  className="shrink-0 rounded-xl border border-ac/35 bg-ac/10 px-4 py-3 text-sm font-bold text-ac transition hover:bg-ac/20"
                >
                  + 워크플로
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
