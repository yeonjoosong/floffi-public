// workspaces.ts — Phase 11 multi-workspace client.
//
// The server holds one row per workspace; this module wraps the REST
// surface and owns the "currently active workspace ID" that every
// other API call must echo back via the X-Workspace-ID header. Keep
// the active ID in a module-level let so callers (board.ts, App.tsx)
// don't have to thread it through every function signature.

// activeWorkspaceID is the workspaceID every subsequent /api/workspace
// request should target. Set by App.tsx on mount + whenever the user
// picks a different workspace in the switcher.
let activeWorkspaceID: string = "";

export function getActiveWorkspaceID(): string {
  return activeWorkspaceID;
}

export function setActiveWorkspaceID(id: string): void {
  activeWorkspaceID = id;
  try {
    if (id) {
      localStorage.setItem("floffi.activeWorkspace", id);
    } else {
      localStorage.removeItem("floffi.activeWorkspace");
    }
  } catch {
    // localStorage unavailable (private mode / quota) — the runtime
    // value still works for this session, so we swallow silently.
  }
}

export function restoreActiveWorkspaceID(): string {
  try {
    const v = localStorage.getItem("floffi.activeWorkspace");
    if (v) activeWorkspaceID = v;
    return activeWorkspaceID;
  } catch {
    return activeWorkspaceID;
  }
}

// workspaceHeaders returns the headers every per-workspace API call
// should include. Exported so board.ts can splice them into existing
// requests without re-implementing the active-ID lookup.
export function workspaceHeaders(): Record<string, string> {
  if (!activeWorkspaceID) return {};
  return { "X-Workspace-ID": activeWorkspaceID };
}

// ── Types ──────────────────────────────────────────────────────────

export type WorkspaceRole = "owner" | "member";

// activeWorkspaceRole mirrors activeWorkspaceID — it's the role the current
// user holds in the currently-selected workspace. App.tsx updates it
// whenever the workspace list resolves or the user switches. Reads are
// synchronous (no network) so per-render gates ("owner-only buttons") stay
// cheap.
let activeWorkspaceRole: WorkspaceRole = "member";

export function getActiveWorkspaceRole(): WorkspaceRole {
  return activeWorkspaceRole;
}

export function setActiveWorkspaceRole(role: WorkspaceRole): void {
  activeWorkspaceRole = role;
}

export function isActiveWorkspaceOwner(): boolean {
  return activeWorkspaceRole === "owner";
}

export type WorkspaceListItem = {
  id: string;
  name: string;
  ownerId: string;
  role: WorkspaceRole;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceListResponse = {
  workspaces: WorkspaceListItem[];
  cap: number;
};

export type WorkspaceMember = {
  userId: string;
  email: string;
  username: string;
  nickname: string;
  role: WorkspaceRole;
  isAdmin: boolean;
  joinedAt: number;
};

export type WorkspaceInvitation = {
  id: string;
  invitedEmail: string;
  expiresAt: number;
  createdAt: number;
};

export type WorkspaceMembersResponse = {
  members: WorkspaceMember[];
  invitations?: WorkspaceInvitation[] | null;
  role: WorkspaceRole;
};

export type WorkspaceInvitationIssued = {
  ok: true;
  token: string;
  expiresAt: number;
  invitedEmail: string;
};

// ── API calls ──────────────────────────────────────────────────────

async function postLikeJSON(url: string, method: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// throwWithCode raises an Error whose `code` field carries the server's
// machine-readable error string. Caller patterns mirror the admin-action
// helpers in auth.ts.
async function throwWithCode(res: Response, fallback: string): Promise<never> {
  let code = "";
  try {
    const body = await res.json();
    code = typeof body?.error === "string" ? body.error : "";
  } catch {
    // body wasn't JSON
  }
  const err = new Error(code || fallback);
  (err as Error & { code?: string }).code = code;
  throw err;
}

export async function listWorkspaces(): Promise<WorkspaceListResponse> {
  const res = await fetch("/api/workspaces", { credentials: "include" });
  if (!res.ok) throw new Error(`list_workspaces_failed_${res.status}`);
  return res.json();
}

export async function createWorkspace(name: string): Promise<WorkspaceListResponse> {
  const res = await postLikeJSON("/api/workspaces", "POST", { name });
  if (!res.ok) return throwWithCode(res, "create_failed");
  return res.json();
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const res = await postLikeJSON(`/api/workspaces/${encodeURIComponent(id)}`, "PATCH", { name });
  if (!res.ok) return throwWithCode(res, "rename_failed");
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) return throwWithCode(res, "delete_failed");
}

export async function listMembers(id: string): Promise<WorkspaceMembersResponse> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}/members`, { credentials: "include" });
  if (!res.ok) return throwWithCode(res, "members_failed");
  return res.json();
}

export async function inviteMember(id: string, email: string): Promise<WorkspaceInvitationIssued> {
  const res = await postLikeJSON(`/api/workspaces/${encodeURIComponent(id)}/members/invite`, "POST", { email });
  if (!res.ok) return throwWithCode(res, "invite_failed");
  return res.json();
}

export async function acceptInvitation(token: string): Promise<{ workspaceId: string }> {
  const res = await postLikeJSON(`/api/workspaces/invitations/accept`, "POST", { token });
  if (!res.ok) return throwWithCode(res, "accept_failed");
  return res.json();
}

export async function removeMember(id: string, userId: string): Promise<void> {
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!res.ok) return throwWithCode(res, "remove_failed");
}

export async function leaveWorkspace(id: string): Promise<void> {
  const res = await postLikeJSON(`/api/workspaces/${encodeURIComponent(id)}/members/leave`, "POST", {});
  if (!res.ok) return throwWithCode(res, "leave_failed");
}

export async function transferOwner(id: string, userId: string): Promise<void> {
  const res = await postLikeJSON(`/api/workspaces/${encodeURIComponent(id)}/transfer-owner`, "POST", { userId });
  if (!res.ok) return throwWithCode(res, "transfer_failed");
}

export async function switchToPersonalMode(id: string, confirmName: string): Promise<{ removedMembers: number }> {
  const res = await postLikeJSON(
    `/api/workspaces/${encodeURIComponent(id)}/mode-personal`,
    "POST",
    { confirmName },
  );
  if (!res.ok) return throwWithCode(res, "switch_failed");
  return res.json();
}
