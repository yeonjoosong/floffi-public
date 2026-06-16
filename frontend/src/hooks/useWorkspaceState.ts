import { useCallback, type Dispatch, type SetStateAction } from "react";
import { hasSection, searchVault } from "../lib/board";
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

type UseWorkspaceStateArgs = {
  authenticated: boolean;
  workspaceReady: boolean;
  vaultDocs: VaultDocument[];
  setBoardTitle: Dispatch<SetStateAction<string>>;
  setSections: Dispatch<SetStateAction<Section[]>>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setWorkspaceSettings: Dispatch<SetStateAction<WorkspaceSettings>>;
  setTeams: Dispatch<SetStateAction<Team[]>>;
  setTeamMembers: Dispatch<SetStateAction<AgentMember[]>>;
  setVaultDocs: Dispatch<SetStateAction<VaultDocument[]>>;
  setProviders: Dispatch<SetStateAction<ProviderConfig[]>>;
  setChannels: Dispatch<SetStateAction<ChannelBadge[]>>;
  setSessions: Dispatch<SetStateAction<SessionHistoryItem[]>>;
  setBossReports: Dispatch<SetStateAction<BossReport[]>>;
  setWebhookConfig: Dispatch<SetStateAction<WebhookConfig>>;
  setNotifications: Dispatch<SetStateAction<NotificationTarget[]>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setTaskTeamId: Dispatch<SetStateAction<string>>;
  setNewMemberTeamId: Dispatch<SetStateAction<string>>;
  setVaultSearchResults: Dispatch<SetStateAction<VaultDocument[]>>;
  setVaultSearchLoading: Dispatch<SetStateAction<boolean>>;
};

export function useWorkspaceState(args: UseWorkspaceStateArgs) {
  const applyWorkspace = useCallback((next: WorkspaceState) => {
    const nextSections = Array.isArray(next.sections) ? next.sections : [];
    const nextTasks = Array.isArray(next.tasks) ? next.tasks : [];
    const nextTeams = Array.isArray(next.teams) ? next.teams : [];
    const nextMembers = Array.isArray(next.teamMembers) ? next.teamMembers : [];
    const nextVaultDocs = Array.isArray(next.vaultDocs) ? next.vaultDocs : [];
    const nextProviders = Array.isArray(next.providers) ? next.providers : [];
    const nextChannels = Array.isArray(next.channels) ? next.channels : [];
    const nextSessions = Array.isArray(next.sessions) ? next.sessions : [];
    const nextReports = Array.isArray(next.bossReports) ? next.bossReports : [];

    args.setBoardTitle(next.boardTitle);
    args.setSections(nextSections);
    args.setTasks(nextTasks);
    args.setWorkspaceSettings(next.workspaceSettings);
    args.setTeams(nextTeams);
    args.setTeamMembers(nextMembers);
    args.setVaultDocs(nextVaultDocs);
    args.setProviders(nextProviders);
    args.setChannels(nextChannels);
    args.setSessions(nextSessions);
    args.setBossReports(nextReports);
    if (next.webhookConfig) args.setWebhookConfig(next.webhookConfig);
    if (Array.isArray(next.notifications)) args.setNotifications(next.notifications);
    args.setStatus((current) => (hasSection(nextSections, current) ? current : nextSections[0]?.id ?? ""));
    args.setTaskTeamId((current) => (nextTeams.some((team) => team.id === current) ? current : nextTeams[0]?.id ?? ""));
    args.setNewMemberTeamId((current) => (nextTeams.some((team) => team.id === current) ? current : nextTeams[0]?.id ?? ""));
    args.setVaultSearchResults(nextVaultDocs);
  }, [args]);

  const runVaultSearch = useCallback(async (nextQuery: string) => {
    if (!args.authenticated || !args.workspaceReady) {
      return;
    }

    args.setVaultSearchLoading(true);
    try {
      const results = await searchVault(nextQuery);
      args.setVaultSearchResults(results);
    } catch {
      args.setVaultSearchResults(args.vaultDocs);
    } finally {
      args.setVaultSearchLoading(false);
    }
  }, [args]);

  return { applyWorkspace, runVaultSearch };
}
