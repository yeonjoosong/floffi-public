import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { EtagMismatchError, fetchWorkspace, saveWorkspace } from "../lib/board";
import { WORKFLOW_SECTIONS } from "../lib/workflow";
import type {
  BossReport,
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
  AgentMember,
  ChannelBadge,
} from "../lib/types";

type UseWorkspacePersistenceArgs = {
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
  isResettingRef: MutableRefObject<boolean>;
  persistAbortRef: MutableRefObject<AbortController | null>;
  lastPersistedRef: MutableRefObject<string | null>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setSections: Dispatch<SetStateAction<Section[]>>;
  setSessions: Dispatch<SetStateAction<SessionHistoryItem[]>>;
  setBossReports: Dispatch<SetStateAction<BossReport[]>>;
  setResetSignal: Dispatch<SetStateAction<number>>;
  setWorkspaceError: Dispatch<SetStateAction<string>>;
  applyWorkspace: (next: WorkspaceState) => void;
};

export function useWorkspacePersistence(args: UseWorkspacePersistenceArgs) {
  const persistWorkspace = useCallback(async () => {
    if (args.isResettingRef.current) return;

    const body = {
      boardTitle: args.boardTitle,
      sections: args.sections,
      tasks: args.tasks,
      workspaceSettings: args.workspaceSettings,
      teams: args.teams,
      teamMembers: args.teamMembers,
      vaultDocs: args.vaultDocs,
      providers: args.providers,
      channels: args.channels,
      sessions: args.sessions,
      bossReports: args.bossReports,
      webhookConfig: args.webhookConfig,
      notifications: args.notifications,
    };
    const payload = JSON.stringify(body);
    if (payload === args.lastPersistedRef.current) return;

    args.persistAbortRef.current?.abort();
    const ctrl = new AbortController();
    args.persistAbortRef.current = ctrl;
    try {
      await saveWorkspace(body, false, ctrl.signal);
      if (ctrl.signal.aborted) return;
      args.lastPersistedRef.current = payload;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof EtagMismatchError) {
        try {
          const fresh = await fetchWorkspace();
          args.applyWorkspace(fresh);
        } catch {
          // ignore — SSE가 곧 알려줄 것
        }
        return;
      }
      args.setWorkspaceError("Workspace failed to save.");
    }
  }, [args]);

  const resetBoard = useCallback(async () => {
    args.persistAbortRef.current?.abort();
    args.persistAbortRef.current = null;
    args.isResettingRef.current = true;
    const now = new Date().toISOString();
    const trashedTasks = args.tasks.map((t) => (t.deletedAt ? t : { ...t, deletedAt: now }));
    const resetSections = WORKFLOW_SECTIONS;
    args.setTasks(trashedTasks);
    args.setSections(resetSections);
    args.setResetSignal((n) => n + 1);
    try {
      localStorage.removeItem("floffi-collapsed-sections");
    } catch {
      // ignore
    }
    try {
      const saved = await saveWorkspace({
        boardTitle: args.boardTitle,
        sections: resetSections,
        tasks: trashedTasks,
        workspaceSettings: args.workspaceSettings,
        teams: args.teams,
        teamMembers: args.teamMembers,
        vaultDocs: args.vaultDocs,
        providers: args.providers,
        channels: args.channels,
        sessions: args.sessions,
        bossReports: args.bossReports,
        webhookConfig: args.webhookConfig,
        notifications: args.notifications,
      }, true);
      args.setTasks(Array.isArray(saved.tasks) ? saved.tasks : []);
      args.setSections(Array.isArray(saved.sections) ? saved.sections : resetSections);
      args.setSessions(Array.isArray(saved.sessions) ? saved.sessions : []);
      args.setBossReports(Array.isArray(saved.bossReports) ? saved.bossReports : []);
    } catch {
      // reset 실패 시 무시 (debounce persist가 곧 재시도)
    } finally {
      args.isResettingRef.current = false;
    }
  }, [args]);

  return { persistWorkspace, resetBoard };
}
