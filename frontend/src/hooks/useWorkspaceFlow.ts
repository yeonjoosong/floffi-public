import { useCallback } from "react";
import { fetchWorkspace } from "../lib/board";
import {
  listWorkspaces,
  restoreActiveWorkspaceID,
  setActiveWorkspaceID as setActiveWorkspaceIDLib,
  setActiveWorkspaceRole as setActiveWorkspaceRoleLib,
  type WorkspaceListItem,
} from "../lib/workspaces";
import type { Session, WorkspaceState } from "../lib/types";

type UseWorkspaceFlowArgs = {
  activeWorkspaceID: string;
  workspaceList: WorkspaceListItem[];
  setSession: (session: Session) => void;
  setSessionLoading: (loading: boolean) => void;
  setWorkspaceLoading: (loading: boolean) => void;
  setWorkspaceError: (error: string) => void;
  setWorkspaceReady: (ready: boolean) => void;
  setWorkspaceList: (items: WorkspaceListItem[]) => void;
  setWorkspaceCap: (cap: number) => void;
  setActiveWorkspaceIDState: (id: string) => void;
  loadStoredTheme: (workspaceId: string) => void;
  applyWorkspace: (next: WorkspaceState) => void;
};

export function useWorkspaceFlow(args: UseWorkspaceFlowArgs) {
  const refreshSession = useCallback(async () => {
    args.setSessionLoading(true);
    try {
      let data: Session = { authenticated: false, username: "" };
      try {
        const response = await fetch("/api/auth/session", { credentials: "include" });
        if (response.ok) {
          data = (await response.json()) as Session;
        }
      } catch {
        // ignore — try legacy below
      }
      if (!data.authenticated) {
        try {
          const legacy = await fetch("/api/session", { credentials: "include" });
          if (legacy.ok) {
            const legacyData = (await legacy.json()) as Session;
            if (legacyData.authenticated) data = legacyData;
          }
        } catch {
          // ignore
        }
      }
      args.setSession(data);
    } finally {
      args.setSessionLoading(false);
    }
  }, [args]);

  const loadWorkspace = useCallback(async () => {
    args.setWorkspaceLoading(true);
    args.setWorkspaceError("");

    try {
      const listResp = await listWorkspaces();
      args.setWorkspaceList(listResp.workspaces);
      args.setWorkspaceCap(listResp.cap);
      let targetID = restoreActiveWorkspaceID();
      if (!targetID || !listResp.workspaces.some((w) => w.id === targetID)) {
        targetID = listResp.workspaces[0]?.id ?? "";
      }
      setActiveWorkspaceIDLib(targetID);
      args.setActiveWorkspaceIDState(targetID);
      const activeRow = listResp.workspaces.find((w) => w.id === targetID);
      setActiveWorkspaceRoleLib(activeRow?.role ?? "member");
      args.loadStoredTheme(targetID);

      const next = await fetchWorkspace();
      args.applyWorkspace(next);
      args.setWorkspaceReady(true);
    } catch {
      args.setWorkspaceError("Workspace failed to load.");
      args.setWorkspaceReady(false);
    } finally {
      args.setWorkspaceLoading(false);
    }
  }, [args]);

  const switchWorkspace = useCallback(async (id: string) => {
    if (!id || id === args.activeWorkspaceID) return;
    setActiveWorkspaceIDLib(id);
    args.setActiveWorkspaceIDState(id);
    const row = args.workspaceList.find((w) => w.id === id);
    setActiveWorkspaceRoleLib(row?.role ?? "member");
    args.loadStoredTheme(id);
    await loadWorkspace();
  }, [args, loadWorkspace]);

  return { refreshSession, loadWorkspace, switchWorkspace };
}
