import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { fetchWorkspace, newId, runTask, saveWorkspace } from "../lib/board";
import { DEFAULT_WORKFLOW_STEPS } from "../lib/workflow";
import type {
  AgentMember,
  BossReport,
  ChannelBadge,
  NotificationTarget,
  ProviderConfig,
  Section,
  SessionHistoryItem,
  Task,
  Team,
  VaultDocument,
  WebhookConfig,
  WorkspaceSettings,
  WorkspaceState,
  WorkflowStep,
} from "../lib/types";
import type { LLMProvider } from "../lib/byok";

type UseReportActionsArgs = {
  boardTitle: string;
  sections: Section[];
  tasks: Task[];
  workspaceSettings: WorkspaceSettings;
  teams: Team[];
  teamMembers: AgentMember[];
  vaultDocs: VaultDocument[];
  providers: ProviderConfig[];
  channels: ChannelBadge[];
  sessions: SessionHistoryItem[];
  bossReports: BossReport[];
  webhookConfig: WebhookConfig;
  notifications: NotificationTarget[];
  blockPollUntilRef: MutableRefObject<number>;
  persistAbortRef: MutableRefObject<AbortController | null>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setTeamMembers: Dispatch<SetStateAction<AgentMember[]>>;
  setSessions: Dispatch<SetStateAction<SessionHistoryItem[]>>;
  setBossReports: Dispatch<SetStateAction<BossReport[]>>;
  spotlightSection: string | null;
  setSpotlightSection: Dispatch<SetStateAction<string | null>>;
  setWorkspaceError: Dispatch<SetStateAction<string>>;
  setFreeTierImageBlockedOpen: Dispatch<SetStateAction<boolean>>;
  applyWorkspace: (next: WorkspaceState) => void;
  activeProvider: () => LLMProvider | undefined;
  userLabel: () => string;
  logEvent: (title: string, summary: string) => void;
  handleAgentError: (message: string, fallbackPrefix: string) => boolean;
  sectionForAgent: (agent: AgentMember | undefined) => Section | undefined;
  isFreeTierImageBlocked: (task: Pick<Task, "imageOutput"> | undefined) => boolean;
};

type RollbackSnapshot = {
  tasks: Task[];
  teamMembers: AgentMember[];
  sessions: SessionHistoryItem[];
  bossReports: BossReport[];
  spotlightSection: string | null;
};

type PersistDraft = {
  tasks: Task[];
  bossReports: BossReport[];
  teamMembers?: AgentMember[];
  sessions?: SessionHistoryItem[];
};

type PersistAndRunArgs = PersistDraft & {
  taskId: string;
  taskTitle: string;
  rollbackSnapshot: RollbackSnapshot;
  blockMs: number;
  onRunSuccess: (updatedWorkspace: WorkspaceState) => void;
  onRunFailure: (message: string) => void;
};

type RestoreTarget = {
  title: string;
  workflowEnabled: boolean;
  workflowStep: number;
  workflowSteps: WorkflowStep[];
  agentId: string;
  assignee: string;
  status: string;
};

export function useReportActions(args: UseReportActionsArgs) {
  const updateMemberStatus = useCallback((members: AgentMember[], memberId: string, status: AgentMember["status"]) => (
    members.map((member) => (member.id === memberId ? { ...member, status } : member))
  ), []);

  const createRollbackSnapshot = useCallback((): RollbackSnapshot => ({
    tasks: args.tasks,
    teamMembers: args.teamMembers,
    sessions: args.sessions,
    bossReports: args.bossReports,
    spotlightSection: args.spotlightSection,
  }), [args]);

  const restoreSnapshot = useCallback((snapshot: RollbackSnapshot) => {
    args.setTasks(snapshot.tasks);
    args.setTeamMembers(snapshot.teamMembers);
    args.setSessions(snapshot.sessions);
    args.setBossReports(snapshot.bossReports);
    args.setSpotlightSection(snapshot.spotlightSection);
  }, [args]);

  const createPersistController = useCallback((blockMs: number) => {
    args.blockPollUntilRef.current = Date.now() + blockMs;
    args.persistAbortRef.current?.abort();
    const ctrl = new AbortController();
    args.persistAbortRef.current = ctrl;
    return ctrl;
  }, [args]);

  const persistWorkspaceDraft = useCallback(async (
    draft: PersistDraft,
    blockMs: number,
    rollbackSnapshot?: RollbackSnapshot,
  ) => {
    const ctrl = createPersistController(blockMs);
    try {
      await saveWorkspace(
        {
          boardTitle: args.boardTitle,
          sections: args.sections,
          tasks: draft.tasks,
          workspaceSettings: args.workspaceSettings,
          teams: args.teams,
          teamMembers: draft.teamMembers ?? args.teamMembers,
          vaultDocs: args.vaultDocs,
          providers: args.providers,
          channels: args.channels,
          sessions: draft.sessions ?? args.sessions,
          bossReports: draft.bossReports,
          webhookConfig: args.webhookConfig,
          notifications: args.notifications,
        },
        false,
        ctrl.signal,
      );
      return true;
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        if (rollbackSnapshot) {
          restoreSnapshot(rollbackSnapshot);
        }
        args.setWorkspaceError("Workspace failed to save.");
      }
      return false;
    }
  }, [args, createPersistController, restoreSnapshot]);

  const persistAndRunTask = useCallback(async ({
    tasks,
    bossReports,
    teamMembers,
    sessions,
    taskId,
    taskTitle,
    rollbackSnapshot,
    blockMs,
    onRunSuccess,
    onRunFailure,
  }: PersistAndRunArgs) => {
    const saved = await persistWorkspaceDraft({ tasks, bossReports, teamMembers, sessions }, blockMs, rollbackSnapshot);
    if (!saved) {
      return;
    }

    try {
      const updatedWorkspace = await runTask(taskId, args.activeProvider());
      onRunSuccess(updatedWorkspace);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      onRunFailure(message);
    }
  }, [args, persistWorkspaceDraft]);

  const findDoneSectionId = useCallback(() => (
    args.sections.find((section) => section.title.toLowerCase() === "done")?.id
      ?? args.sections[args.sections.length - 1]?.id
      ?? ""
  ), [args.sections]);

  const deriveRestoreTarget = useCallback((report: BossReport): RestoreTarget => {
    const reportTeamMembers = args.teamMembers.filter((member) => member.teamId === report.teamId);
    const plannerAgent = reportTeamMembers.find((member) => member.id === "planner");
    const reportAgent = reportTeamMembers.find((member) => member.id === report.agentId);
    const workflowEnabled = report.workflowEnabled === true;
    const workflowSteps = workflowEnabled && Array.isArray(report.workflowSteps) && report.workflowSteps.length > 0
      ? report.workflowSteps
      : DEFAULT_WORKFLOW_STEPS;
    const workflowStep = workflowEnabled
      ? Math.min(Math.max(report.workflowStep ?? 0, 0), Math.max(workflowSteps.length - 1, 0))
      : 0;
    const workflowAgentId = workflowEnabled ? workflowSteps[workflowStep]?.agentId ?? report.agentId : "";
    const workflowAgent = reportTeamMembers.find((member) => member.id === workflowAgentId);
    const fallbackAgent = workflowEnabled
      ? workflowAgent ?? reportAgent ?? plannerAgent ?? reportTeamMembers[0]
      : reportAgent ?? plannerAgent ?? reportTeamMembers[0];

    return {
      title: report.taskTitle?.trim() || report.title.trim(),
      workflowEnabled,
      workflowStep: workflowEnabled ? workflowStep : 0,
      workflowSteps: workflowEnabled ? workflowSteps : [],
      agentId: workflowEnabled ? (workflowAgent?.id ?? workflowAgentId) : (fallbackAgent?.id ?? report.agentId),
      assignee: fallbackAgent?.name ?? "",
      status: workflowEnabled
        ? workflowSteps[workflowStep]?.sectionId ?? args.sections[0]?.id ?? ""
        : args.sectionForAgent(fallbackAgent)?.id ?? args.sections[0]?.id ?? "",
    };
  }, [args]);

  const completeTask = useCallback((taskId: string) => {
    const doneSectionId = findDoneSectionId();
    const targetTask = args.tasks.find((task) => task.id === taskId);
    if (!targetTask) return;

    const agent = args.teamMembers.find((member) => member.id === targetTask.agentId);
    const team = args.teams.find((item) => item.id === targetTask.teamId);
    const nextReportId = targetTask.reportId || newId();

    args.setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? { ...task, executionStatus: "completed", status: doneSectionId || task.status, reportId: nextReportId }
          : task,
      ),
    );

    if (agent) {
      args.setTeamMembers((current) =>
        current.map((member) => (member.id === agent.id ? { ...member, status: "idle" } : member)),
      );
    }

    args.setBossReports((current) => {
      if (current.some((report) => report.id === nextReportId)) {
        return current;
      }

      const nextReport: BossReport = {
        id: nextReportId,
        taskId,
        teamId: targetTask.teamId,
        agentId: targetTask.agentId,
        title: `${targetTask.title} completed`,
        summary: `${agent?.name || "Assigned agent"} from ${team?.name || "the team"} completed the task and reported back to the boss.`,
        deliveredAt: new Date().toISOString(),
        status: "new",
        taskTitle: targetTask.title,
        workflowEnabled: targetTask.workflowEnabled,
        workflowStep: targetTask.workflowStep,
        workflowSteps: targetTask.workflowSteps,
      };

      return [nextReport, ...current];
    });

    if (doneSectionId) {
      args.setSpotlightSection(doneSectionId);
    }
    args.logEvent("Task completed", `${targetTask.title} was completed and reported back to the boss.`);
  }, [args, findDoneSectionId]);

  const rejectReport = useCallback((reportId: string, feedback: string) => {
    const report = args.bossReports.find((item) => item.id === reportId);
    if (!report) return;

    const rollbackSnapshot = createRollbackSnapshot();
    const targetTask = args.tasks.find((task) => task.id === report.taskId);
    if (args.isFreeTierImageBlocked(targetTask)) {
      args.setFreeTierImageBlockedOpen(true);
      return;
    }

    const nextBossReports = args.bossReports.map((item) =>
      item.id === reportId ? { ...item, status: "rejected" as const, feedback } : item,
    );

    let reworkSectionId: string | undefined;
    if (!targetTask?.workflowEnabled && targetTask) {
      const doneSectionId = findDoneSectionId();
      if (doneSectionId && targetTask.status === doneSectionId) {
        const agent = args.teamMembers.find((member) => member.id === targetTask.agentId);
        reworkSectionId = args.sectionForAgent(agent)?.id;
      }
    }

    const nextTasks = args.tasks.map((task) => {
      if (task.id !== report.taskId) return task;
      const header = task.workflowEnabled
        ? `${args.userLabel()} 피드백 (Step ${task.workflowStep + 1})`
        : `${args.userLabel()} 피드백 (${new Date().toISOString()})`;
      const entry = feedback ? `\n\n--- ${header} ---\n${feedback}` : "";
      return {
        ...task,
        status: reworkSectionId ?? task.status,
        executionStatus: "active" as const,
        accumulatedContext: task.accumulatedContext + entry,
      };
    });

    const taskId = report.taskId;
    const taskTitle = nextTasks.find((task) => task.id === taskId)?.title ?? taskId;
    const rerunAgentId = nextTasks.find((task) => task.id === taskId)?.agentId ?? "";
    const rerunMembers = rerunAgentId ? updateMemberStatus(args.teamMembers, rerunAgentId, "busy") : args.teamMembers;
    const nextSessions = [
      {
        id: newId(),
        title: "재요청 LLM 실행 중",
        summary: `"${taskTitle}" 에이전트 재실행 시작.`,
        updatedAt: new Date().toISOString(),
      },
      {
        id: newId(),
        title: "보고서 재요청",
        summary: `"${report.title}": ${args.userLabel()}가 수정을 요청했습니다.`,
        updatedAt: new Date().toISOString(),
      },
      ...args.sessions,
    ].slice(0, 20);

    args.setBossReports(nextBossReports);
    args.setTasks(nextTasks);
    if (rerunAgentId) {
      args.setTeamMembers(rerunMembers);
    }
    args.setSessions(nextSessions);
    if (reworkSectionId) {
      args.setSpotlightSection(reworkSectionId);
    }

    void persistAndRunTask({
      tasks: nextTasks,
      bossReports: nextBossReports,
      teamMembers: rerunMembers,
      sessions: nextSessions,
      taskId,
      taskTitle,
      rollbackSnapshot,
      blockMs: 120_000,
      onRunSuccess: (updatedWorkspace) => {
        args.applyWorkspace(updatedWorkspace);
        args.logEvent("재요청 완료", `"${taskTitle}" 재실행 완료. 새 보고서가 도착했습니다.`);
      },
      onRunFailure: (message) => {
        args.handleAgentError(message, "재요청 실행 실패");
        args.logEvent("재요청 실행 실패", `"${taskTitle}": ${message}`);
        void fetchWorkspace()
          .then((workspace) => {
            const restoredReports = workspace.bossReports.map((item) =>
              item.id === reportId ? { ...item, status: "new" as const } : item,
            );
            const restoredWorkspace = { ...workspace, bossReports: restoredReports };
            args.applyWorkspace(restoredWorkspace);
            void saveWorkspace(restoredWorkspace, false).catch(() => {});
          })
          .catch(() => {
            args.setTasks((current) =>
              current.map((task) => (task.id === taskId ? { ...task, executionStatus: "queued" } : task)),
            );
            args.setBossReports((current) =>
              current.map((item) => (item.id === reportId ? { ...item, status: "new" } : item)),
            );
          });
      },
    });
  }, [args, createRollbackSnapshot, findDoneSectionId, persistAndRunTask, updateMemberStatus]);

  const restoreTask = useCallback((reportId: string) => {
    const report = args.bossReports.find((item) => item.id === reportId);
    if (!report) return;
    if (args.tasks.some((task) => task.id === report.taskId)) return;

    const restoreTarget = deriveRestoreTarget(report);
    const rollbackSnapshot = createRollbackSnapshot();
    const restoredTask: Task = {
      id: report.taskId,
      title: restoreTarget.title,
      description: "",
      assignee: restoreTarget.assignee,
      status: restoreTarget.status,
      createdAt: new Date().toISOString(),
      date: "",
      teamId: report.teamId,
      agentId: restoreTarget.agentId,
      executionStatus: "queued",
      reportId: "",
      workflowEnabled: restoreTarget.workflowEnabled,
      workflowStep: restoreTarget.workflowStep,
      workflowSteps: restoreTarget.workflowSteps,
      accumulatedContext: "",
    };

    const nextTasks = [restoredTask, ...args.tasks];
    args.setTasks(nextTasks);
    args.logEvent("태스크 복구", `"${restoredTask.title}" 태스크가 적절한 작업열로 복구되었습니다.`);
    void persistWorkspaceDraft({ tasks: nextTasks, bossReports: args.bossReports }, 4_000, rollbackSnapshot);
  }, [args, createRollbackSnapshot, deriveRestoreTarget, persistWorkspaceDraft]);

  const approveReport = useCallback((reportId: string) => {
    const report = args.bossReports.find((item) => item.id === reportId);
    if (report) {
      const task = args.tasks.find((candidate) => candidate.id === report.taskId);
      const hasNextStep = !!task?.workflowEnabled && task.workflowSteps.length > 0 && task.workflowStep + 1 < task.workflowSteps.length;
      if (hasNextStep && args.isFreeTierImageBlocked(task)) {
        args.setFreeTierImageBlockedOpen(true);
        return;
      }
    }

    const rollbackSnapshot = createRollbackSnapshot();
    const nextBossReports = args.bossReports.map((item) =>
      item.id === reportId ? { ...item, status: "approved" as const } : item,
    );
    args.setBossReports(nextBossReports);

    let nextTasks = args.tasks;
    let nextStepTaskId: string | null = null;
    let nextRunMembers = args.teamMembers;

    if (report) {
      const task = args.tasks.find((candidate) => candidate.id === report.taskId);
      if (task?.workflowEnabled && task.workflowSteps.length > 0) {
        const nextStep = task.workflowStep + 1;
        if (nextStep < task.workflowSteps.length) {
          const nextStepDef = task.workflowSteps[nextStep];
          const nextAgent = args.teamMembers.find((member) => member.id === nextStepDef.agentId);
          nextRunMembers = nextAgent ? updateMemberStatus(args.teamMembers, nextAgent.id, "busy") : args.teamMembers;
          nextTasks = args.tasks.map((candidate) =>
            candidate.id === task.id
              ? {
                ...candidate,
                workflowStep: nextStep,
                status: nextStepDef.sectionId,
                agentId: nextStepDef.agentId,
                assignee: nextAgent?.name ?? nextStepDef.agentId,
                executionStatus: "active" as const,
                reportId: "",
              }
              : candidate,
          );
          args.setTasks(nextTasks);
          if (nextAgent) {
            args.setTeamMembers(nextRunMembers);
          }
          args.setSpotlightSection(nextStepDef.sectionId);
          args.logEvent("워크플로 진행", `"${task.title}": ${nextStep + 1}/${task.workflowSteps.length}단계 (${nextStepDef.label}) 시작`);
          nextStepTaskId = task.id;
        } else {
          const doneSectionId = findDoneSectionId();
          if (doneSectionId) {
            nextTasks = args.tasks.map((candidate) => candidate.id === task.id ? { ...candidate, status: doneSectionId } : candidate);
            args.setTasks(nextTasks);
            args.setSpotlightSection(doneSectionId);
          }
          args.logEvent("워크플로 완료", `"${task.title}" 전체 워크플로가 완료되었습니다.`);
        }
      }
      args.logEvent("Report approved", `${report.title} was approved by the boss.`);
    }

    if (!nextStepTaskId) {
      void persistWorkspaceDraft({ tasks: nextTasks, bossReports: nextBossReports }, 4_000, rollbackSnapshot);
      return;
    }

    const taskId = nextStepTaskId;
    const taskTitle = nextTasks.find((task) => task.id === taskId)?.title ?? taskId;
    void persistAndRunTask({
      tasks: nextTasks,
      bossReports: nextBossReports,
      teamMembers: nextRunMembers,
      taskId,
      taskTitle,
      rollbackSnapshot,
      blockMs: 120_000,
      onRunSuccess: (updatedWorkspace) => {
        args.applyWorkspace(updatedWorkspace);
        args.logEvent("워크플로 스텝 완료", `"${taskTitle}" 스텝 완료. ${args.userLabel()} 검토 대기 중.`);
      },
      onRunFailure: (message) => {
        args.handleAgentError(message, "워크플로 실행 실패");
        void fetchWorkspace().then(args.applyWorkspace).catch(() => {
          args.setTasks((current) =>
            current.map((task) => (task.id === taskId ? { ...task, executionStatus: "queued" } : task)),
          );
        });
      },
    });
  }, [args, createRollbackSnapshot, findDoneSectionId, persistAndRunTask, persistWorkspaceDraft, updateMemberStatus]);

  return { completeTask, rejectReport, restoreTask, approveReport };
}
