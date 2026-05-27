import type { ReactNode, RefObject } from "react";
import { Card, DangerBtn, EmptyMsg, FInput, FSelect, FTextarea, PrimaryBtn, SideSection } from "./BoardViewPrimitives";
import type { AgentMember, Team } from "../lib/types";

type BoardLeftSidebarProps = {
  leftDrawerOpen: boolean;
  leftTab: "teams" | "agents";
  leftDrawerScrollRef: RefObject<HTMLDivElement | null>;
  teams: Team[];
  teamMembers: AgentMember[];
  newTeamName: string;
  newTeamMission: string;
  newMemberTeamId: string;
  newMemberName: string;
  newMemberRole: string;
  onSetLeftTab: (tab: "teams" | "agents") => void;
  onNewTeamNameChange: (value: string) => void;
  onNewTeamMissionChange: (value: string) => void;
  onCreateTeam: () => void;
  onRemoveTeam: (teamId: string) => void;
  onNewMemberTeamIdChange: (value: string) => void;
  onNewMemberNameChange: (value: string) => void;
  onNewMemberRoleChange: (value: string) => void;
  onAddTeamMember: () => void;
  onRemoveTeamMember: (memberId: string) => void;
};

function StatusDot(props: { status: string }) {
  const c: Record<string, string> = {
    idle: "bg-ok",
    busy: "animate-pulse bg-ac",
    offline: "bg-t3",
  };
  return <span className={`h-2 w-2 shrink-0 rounded-full ${c[props.status] ?? "bg-t3"}`} />;
}

function TeamIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="inline-block">
      <circle cx="5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1 14c0-2.21 1.79-4 4-4h6c2.21 0 4 1.79 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="inline-block">
      <rect x="3" y="6" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 6V4a2 2 0 1 1 4 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6" cy="10" r="1" fill="currentColor" />
      <circle cx="10" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

function SidebarTab(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-role={props.active ? "sidebar-tab-active" : "sidebar-tab"}
      className={[
        "flex h-12 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-xs font-bold transition",
        props.active ? "border-b-2 border-ac text-t1" : "text-t3 hover:text-t2",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}

export function BoardLeftSidebar(props: BoardLeftSidebarProps) {
  return (
    <aside
      data-role="left-sidebar"
      className={[
        "flex w-[85vw] max-w-[320px] shrink-0 flex-col overflow-hidden border-r border-bd/10 bg-s1",
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-2xl max-md:transition-transform max-md:duration-200",
        props.leftDrawerOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        "md:w-64 md:translate-x-0 xl:w-72",
      ].join(" ")}
    >
      <div className="flex shrink-0 items-center border-b border-bd/10">
        <SidebarTab active={props.leftTab === "teams"} onClick={() => props.onSetLeftTab("teams")}>
          <TeamIcon /> 팀
        </SidebarTab>
        <SidebarTab active={props.leftTab === "agents"} onClick={() => props.onSetLeftTab("agents")}>
          <AgentIcon /> 에이전트
        </SidebarTab>
      </div>

      <div ref={props.leftDrawerScrollRef} className="flex-1 space-y-5 overflow-y-auto p-4 [scrollbar-gutter:stable]">
        {props.leftTab === "teams" ? (
          <>
            <SideSection title="새 팀 만들기">
              <div className="space-y-2">
                <FInput value={props.newTeamName} onChange={props.onNewTeamNameChange} placeholder="팀 이름" onSubmit={props.onCreateTeam} />
                <FTextarea
                  value={props.newTeamMission}
                  onChange={props.onNewTeamMissionChange}
                  placeholder="팀 미션 (선택)"
                  rows={2}
                  onCancel={() => {
                    props.onNewTeamNameChange("");
                    props.onNewTeamMissionChange("");
                  }}
                />
                <PrimaryBtn onClick={props.onCreateTeam} full>+ 팀 추가</PrimaryBtn>
              </div>
            </SideSection>

            <SideSection title={`팀 목록 · ${props.teams.length}개`}>
              {props.teams.length === 0 ? (
                <EmptyMsg>팀이 없습니다. 위에서 팀을 추가해 보세요.</EmptyMsg>
              ) : (
                <div className="space-y-2">
                  {props.teams.map((team) => (
                    <Card key={team.id}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-t1">{team.name}</p>
                          <p className="mt-0.5 line-clamp-2 text-xs text-t3">{team.mission || "미션 없음"}</p>
                        </div>
                        <DangerBtn onClick={() => props.onRemoveTeam(team.id)}>삭제</DangerBtn>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </SideSection>
          </>
        ) : (
          <>
            <SideSection title="에이전트 추가">
              <div className="space-y-2">
                <FSelect
                  value={props.newMemberTeamId}
                  onChange={props.onNewMemberTeamIdChange}
                  options={props.teams.map((team) => ({ value: team.id, label: team.name }))}
                  placeholder="팀 선택"
                />
                <FInput value={props.newMemberName} onChange={props.onNewMemberNameChange} placeholder="에이전트 이름" onSubmit={props.onAddTeamMember} />
                <FInput value={props.newMemberRole} onChange={props.onNewMemberRoleChange} placeholder="역할 (선택)" onSubmit={props.onAddTeamMember} />
                <PrimaryBtn onClick={props.onAddTeamMember} full>+ 에이전트 추가</PrimaryBtn>
              </div>
            </SideSection>

            <SideSection title={`에이전트 · ${props.teamMembers.length}명`}>
              {props.teamMembers.length === 0 ? (
                <EmptyMsg>에이전트가 없습니다.</EmptyMsg>
              ) : (
                <div className="space-y-2">
                  {props.teamMembers.map((member) => {
                    const team = props.teams.find((item) => item.id === member.teamId);
                    return (
                      <Card key={member.id}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <StatusDot status={member.status} />
                              <p className="truncate text-sm font-bold text-t1">{member.name}</p>
                            </div>
                            <p className="mt-0.5 text-xs text-t3">
                              {team?.name || "팀 없음"} · {member.role || "역할 없음"}
                            </p>
                          </div>
                          <DangerBtn onClick={() => props.onRemoveTeamMember(member.id)}>삭제</DangerBtn>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </SideSection>
          </>
        )}
      </div>
    </aside>
  );
}
