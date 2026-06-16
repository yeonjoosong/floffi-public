import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { fetchWorkspace, hasSection, newId, runTask, saveWorkspace, uploadAttachment } from "../lib/board";
import { DEFAULT_WORKFLOW_STEPS, WORKFLOW_SECTIONS, makeWorkflowAgents } from "../lib/workflow";
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
} from "../lib/types";
import type { LLMProvider } from "../lib/byok";

type UseTaskActionsArgs = {
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
  title: string;
  description: string;
  pendingFiles: File[];
  imageOutput: boolean;
  imageGridCount: number;
  assignee: string;
  status: string;
  date: string;
  taskTeamId: string;
  taskAgentId: string;
  blockPollUntilRef: MutableRefObject<number>;
  setSections: Dispatch<SetStateAction<Section[]>>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setTeamMembers: Dispatch<SetStateAction<AgentMember[]>>;
  setTitle: Dispatch<SetStateAction<string>>;
  setDescription: Dispatch<SetStateAction<string>>;
  setAssignee: Dispatch<SetStateAction<string>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setDate: Dispatch<SetStateAction<string>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setPendingFiles: Dispatch<SetStateAction<File[]>>;
  setImageOutput: Dispatch<SetStateAction<boolean>>;
  setImageGridCount: Dispatch<SetStateAction<number>>;
  setSpotlightSection: Dispatch<SetStateAction<string | null>>;
  setTitleMissingOpen: Dispatch<SetStateAction<boolean>>;
  setApiKeyMissingOpen: Dispatch<SetStateAction<boolean>>;
  setFreeTierImageBlockedOpen: Dispatch<SetStateAction<boolean>>;
  applyWorkspace: (next: WorkspaceState) => void;
  activeProvider: () => LLMProvider | undefined;
  handleAgentError: (message: string, fallbackPrefix: string) => boolean;
  isFreeTierImageBlocked: (task: Pick<Task, "imageOutput"> | undefined) => boolean;
  hasAnyUsableBYOKKey: () => boolean;
  sectionForAgent: (agent: AgentMember | undefined) => Section | undefined;
  logEvent: (title: string, summary: string) => void;
  userLabel: () => string;
};

export function useTaskActions(args: UseTaskActionsArgs) {
  const uploadPendingFiles = useCallback(async (taskId: string, files: File[]) => {
    const uploaded: Awaited<ReturnType<typeof uploadAttachment>>[] = [];
    for (const f of files) {
      try {
        const att = await uploadAttachment(taskId, f);
        uploaded.push(att);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "업로드 실패";
        args.logEvent("파일 업로드 실패", `"${f.name}": ${msg}`);
      }
    }
    return uploaded;
  }, [args]);

  const createTask = useCallback(() => {
    const trimmedTitle = args.title.trim();
    if (!trimmedTitle) {
      args.setTitleMissingOpen(true);
      return;
    }

    if (!args.hasAnyUsableBYOKKey()) {
      args.setApiKeyMissingOpen(true);
    }

    const nextStatus = hasSection(args.sections, args.status) ? args.status : args.sections[0]?.id ?? "";
    const nextTeamId = args.teams.some((team) => team.id === args.taskTeamId) ? args.taskTeamId : args.teams[0]?.id ?? "";
    const candidateAgents = args.teamMembers.filter((member) => !nextTeamId || member.teamId === nextTeamId);
    const nextAgentId = candidateAgents.some((member) => member.id === args.taskAgentId) ? args.taskAgentId : candidateAgents[0]?.id ?? "";
    const assigneeName = args.teamMembers.find((member) => member.id === nextAgentId)?.name ?? args.assignee.trim();
    const nextTask: Task = {
      id: newId(),
      title: trimmedTitle,
      description: args.description.trim(),
      assignee: assigneeName,
      status: nextStatus,
      createdAt: new Date().toISOString(),
      date: args.date,
      teamId: nextTeamId,
      agentId: nextAgentId,
      executionStatus: "queued",
      reportId: "",
      workflowEnabled: false,
      workflowStep: 0,
      workflowSteps: [],
      accumulatedContext: "",
      imageOutput: args.imageOutput,
      imageGridCount: args.imageOutput ? args.imageGridCount : undefined,
    };

    const filesToUpload = args.pendingFiles;

    args.setTasks((current) => [nextTask, ...current]);
    args.setTitle("");
    args.setDescription("");
    args.setAssignee("");
    args.setStatus(args.sections[0]?.id ?? "");
    args.setDate("");
    args.setQuery("");
    args.setPendingFiles([]);
    args.setImageOutput(false);
    args.setImageGridCount(1);
    args.setSpotlightSection(nextStatus);
    args.logEvent(
      "Task assigned",
      `${trimmedTitle} was assigned to ${assigneeName || "an agent"} in ${args.teams.find((team) => team.id === nextTeamId)?.name || "a team"}.`,
    );

    if (filesToUpload.length > 0) {
      void (async () => {
        await new Promise((r) => setTimeout(r, 400));
        const uploaded = await uploadPendingFiles(nextTask.id, filesToUpload);
        if (uploaded.length > 0) {
          args.setTasks((current) =>
            current.map((t) => (t.id === nextTask.id ? { ...t, attachments: uploaded } : t)),
          );
          args.logEvent("파일 업로드 완료", `"${trimmedTitle}"에 ${uploaded.length}개 파일이 첨부되었습니다.`);
        }
      })();
    }
  }, [args, uploadPendingFiles]);

  const createWorkflowTask = useCallback(() => {
    const trimmedTitle = args.title.trim();
    if (!trimmedTitle) {
      args.setTitleMissingOpen(true);
      return;
    }

    if (!args.hasAnyUsableBYOKKey()) {
      args.setApiKeyMissingOpen(true);
      return;
    }

    if (args.isFreeTierImageBlocked({ imageOutput: args.imageOutput })) {
      args.setFreeTierImageBlockedOpen(true);
      return;
    }

    const defaultTeamId = args.teams[0]?.id ?? "";
    const missingSections = WORKFLOW_SECTIONS.filter((ws) => !args.sections.some((s) => s.id === ws.id));
    const newSections: Section[] = missingSections.length === 0 ? args.sections : (() => {
      const doneIdx = args.sections.findIndex((s) => s.id === "done");
      if (doneIdx >= 0) {
        const next = [...args.sections];
        next.splice(doneIdx, 0, ...missingSections);
        return next;
      }
      return [...args.sections, ...missingSections];
    })();

    const missingAgents = makeWorkflowAgents(defaultTeamId)
      .filter((wa) => !args.teamMembers.some((m) => m.id === wa.id));
    const newTeamMembers: AgentMember[] = missingAgents.length === 0
      ? args.teamMembers
      : [...args.teamMembers, ...missingAgents];

    const firstStep = DEFAULT_WORKFLOW_STEPS[0];
    const firstAgent = newTeamMembers.find((m) => m.id === firstStep.agentId);
    const assigneeName = firstAgent?.name ?? "Planner";
    const persistedTeamMembers = firstAgent
      ? newTeamMembers.map((member) => (member.id === firstAgent.id ? { ...member, status: "busy" as const } : member))
      : newTeamMembers;

    const nextTask: Task = {
      id: newId(),
      title: trimmedTitle,
      description: args.description.trim(),
      assignee: assigneeName,
      status: firstStep.sectionId,
      createdAt: new Date().toISOString(),
      date: args.date,
      teamId: defaultTeamId,
      agentId: firstStep.agentId,
      executionStatus: "queued",
      reportId: "",
      workflowEnabled: true,
      workflowStep: 0,
      workflowSteps: DEFAULT_WORKFLOW_STEPS,
      accumulatedContext: "",
      imageOutput: args.imageOutput,
      imageGridCount: args.imageOutput ? args.imageGridCount : undefined,
    };

    const newTasks = [nextTask, ...args.tasks];
    args.setSections(newSections);
    args.setTeamMembers(persistedTeamMembers);
    args.setTasks(newTasks.map((t) => (t.id === nextTask.id ? { ...t, executionStatus: "active" } : t)));
    const filesToUpload = args.pendingFiles;

    args.setTitle("");
    args.setDescription("");
    args.setDate("");
    args.setPendingFiles([]);
    args.setImageOutput(false);
    args.setImageGridCount(1);
    args.setSpotlightSection(firstStep.sectionId);
    args.logEvent("워크플로 태스크 생성", `"${trimmedTitle}" 워크플로가 시작되었습니다. (${DEFAULT_WORKFLOW_STEPS.length}단계)`);

    args.blockPollUntilRef.current = Date.now() + 120_000;
    void saveWorkspace(
      {
        boardTitle: args.boardTitle,
        sections: newSections,
        tasks: newTasks,
        workspaceSettings: args.workspaceSettings,
        teams: args.teams,
        teamMembers: persistedTeamMembers,
        vaultDocs: args.vaultDocs,
        providers: args.providers,
        channels: args.channels,
        sessions: args.sessions,
        bossReports: args.bossReports,
        webhookConfig: args.webhookConfig,
        notifications: args.notifications,
      },
    ).then(async () => {
      if (filesToUpload.length > 0) {
        const uploaded = await uploadPendingFiles(nextTask.id, filesToUpload);
        if (uploaded.length > 0) {
          args.setTasks((current) =>
            current.map((t) => (t.id === nextTask.id ? { ...t, attachments: uploaded } : t)),
          );
          args.logEvent("파일 업로드 완료", `"${trimmedTitle}"에 ${uploaded.length}개 파일이 첨부되었습니다.`);
        }
      }
      void runTask(nextTask.id, args.activeProvider())
        .then((updatedWorkspace) => {
          args.applyWorkspace(updatedWorkspace);
          args.logEvent("워크플로 스텝 완료", `"${trimmedTitle}" 1/${DEFAULT_WORKFLOW_STEPS.length}단계 완료. ${args.userLabel()} 검토 대기 중.`);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "알 수 없는 오류";
          args.handleAgentError(message, "워크플로 실행 실패");
          args.logEvent("워크플로 실패", `"${trimmedTitle}": ${message}`);
          void fetchWorkspace().then(args.applyWorkspace).catch(() => {
            args.setTasks((current) =>
              current.map((t) => (t.id === nextTask.id ? { ...t, executionStatus: "queued" } : t)),
            );
          });
        });
    }).catch(() => {
      args.setTasks((current) =>
        current.map((t) => (t.id === nextTask.id ? { ...t, executionStatus: "queued" } : t)),
      );
      if (firstAgent) {
        args.setTeamMembers((current) =>
          current.map((m) => (m.id === firstAgent.id ? { ...m, status: "idle" } : m)),
        );
      }
    });
  }, [args, uploadPendingFiles]);

  const setTaskExecution = useCallback((taskId: string, executionStatus: Task["executionStatus"]) => {
    const task = args.tasks.find((item) => item.id === taskId);
    if (executionStatus === "active") {
      if (args.isFreeTierImageBlocked(task)) {
        args.setFreeTierImageBlockedOpen(true);
        args.logEvent("이미지 생성 차단", `"${task?.title ?? taskId}": 무료 모델은 이미지 생성을 지원하지 않습니다.`);
        return;
      }
      const doneSectionId = args.sections.find((s) => s.title.toLowerCase() === "done")?.id ?? "";
      const isRerunFromDone =
        !!task && task.executionStatus === "completed" && !!doneSectionId && task.status === doneSectionId;
      let nextStatus: string | undefined;
      let nextWorkflowStep: number | undefined;
      if (isRerunFromDone && task) {
        if (task.workflowEnabled && task.workflowSteps && task.workflowSteps.length > 0) {
          nextStatus = task.workflowSteps[0].sectionId;
          nextWorkflowStep = 0;
        } else {
          const agent = args.teamMembers.find((m) => m.id === task.agentId);
          nextStatus = args.sectionForAgent(agent)?.id ?? args.sections.find((s) => s.id !== doneSectionId)?.id;
        }
      }
      args.setTasks((current) =>
        current.map((t) => {
          if (t.id !== taskId) return t;
          const patch: Partial<Task> = { executionStatus: "active" };
          if (nextStatus) patch.status = nextStatus;
          if (nextWorkflowStep !== undefined) patch.workflowStep = nextWorkflowStep;
          return { ...t, ...patch } as Task;
        }),
      );
      if (nextStatus) args.setSpotlightSection(nextStatus);
      if (task?.agentId) {
        args.setTeamMembers((current) =>
          current.map((member) => (member.id === task.agentId ? { ...member, status: "busy" } : member)),
        );
      }
      if (task) {
        args.logEvent("태스크 시작", `${task.title} 실행 중...`);
      }

      void runTask(taskId, args.activeProvider())
        .then((updatedWorkspace) => {
          args.applyWorkspace(updatedWorkspace);
          args.logEvent("태스크 완료", `에이전트가 ${task?.title ?? taskId} 태스크를 완료했습니다.`);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "알 수 없는 오류";
          args.handleAgentError(message, "에이전트 실행 실패");
          args.logEvent("태스크 실패", `${task?.title ?? taskId}: ${message}`);
          void fetchWorkspace()
            .then((ws) => {
              args.applyWorkspace(ws);
            })
            .catch(() => {
              args.setTasks((current) =>
                current.map((t) => (t.id === taskId ? { ...t, executionStatus: "queued" } : t)),
              );
              if (task?.agentId) {
                args.setTeamMembers((current) =>
                  current.map((member) => (member.id === task.agentId ? { ...member, status: "idle" } : member)),
                );
              }
            });
        });
    } else {
      args.setTasks((current) =>
        current.map((t) => (t.id === taskId ? { ...t, executionStatus } : t)),
      );
    }
  }, [args]);

  return { createTask, createWorkflowTask, setTaskExecution };
}
