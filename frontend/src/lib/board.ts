import { apiFetch, type LLMProvider } from "./byok";
import type { TaskAttachment, VaultSearchResponse, WorkspaceState } from "./types";
import { workspaceHeaders } from "./workspaces";

// Latest ETag observed on /api/workspace responses. Sent as If-Match on PUT
// so the server can reject stale writes (optimistic concurrency).
let lastETag = "";

export function getWorkspaceETag(): string {
  return lastETag;
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function hasSection(sections: WorkspaceState["sections"], sectionID: string): boolean {
  return sections.some((section) => section.id === sectionID);
}

export async function fetchWorkspace(): Promise<WorkspaceState> {
  const response = await fetch("/api/workspace", {
    credentials: "include",
    headers: workspaceHeaders(),
  });

  // 401 must be distinguishable from generic failures — callers branch
  // on it to trigger the logout flow when another device revoked this
  // session under single_session last-wins. Lumping it into a generic
  // "workspace_fetch_failed" used to swallow it as a transient network
  // hiccup.
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    throw new Error("workspace_fetch_failed");
  }

  const etag = response.headers.get("ETag");
  if (etag) lastETag = etag;
  return (await response.json()) as WorkspaceState;
}

export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); this.name = "UnauthorizedError"; }
}

export class EtagMismatchError extends Error {
  constructor() { super("etag_mismatch"); this.name = "EtagMismatchError"; }
}

export async function saveWorkspace(
  workspace: WorkspaceState,
  reset = false,
  signal?: AbortSignal,
): Promise<WorkspaceState> {
  const url = reset ? "/api/workspace?reset=true" : "/api/workspace";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...workspaceHeaders(),
  };
  // If-Match enables optimistic concurrency. Skip on reset (intentional clobber).
  if (lastETag && !reset) {
    headers["If-Match"] = lastETag;
  }
  const response = await fetch(url, {
    method: "PUT",
    credentials: "include",
    headers,
    body: JSON.stringify(workspace),
    signal,
  });

  if (response.status === 412) {
    throw new EtagMismatchError();
  }
  if (!response.ok) {
    throw new Error("workspace_save_failed");
  }

  const etag = response.headers.get("ETag");
  if (etag) lastETag = etag;
  return (await response.json()) as WorkspaceState;
}

// subscribeWorkspaceStream connects to the server's SSE channel and invokes
// `onChange(serverETag)` every time the workspace mutates. Returns a teardown
// function. Auto-reconnects on transient network errors (browser handles it).
//
// `onSessionRevoked` is called when the server pushes a "session-revoked"
// event — this happens when another device signed in under single_session
// last-wins and the server's heartbeat noticed our refresh row is now
// marked revoked. We close the stream and hand control back to the caller
// so it can run its logout flow (no waiting for the next polled fetch to
// 401 in).
export function subscribeWorkspaceStream(
  onChange: (serverETag: string) => void,
  onSessionRevoked?: () => void,
): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  // EventSource doesn't let us set arbitrary headers (browser API limit),
  // so we pass the active workspace ID via query string. The server's
  // resolveActiveWorkspace already checks the query param fallback.
  const hdr = workspaceHeaders()["X-Workspace-ID"];
  const url = hdr ? `/api/workspace/stream?workspace_id=${encodeURIComponent(hdr)}` : "/api/workspace/stream";
  const es = new EventSource(url, { withCredentials: true });
  const handleChange = (e: MessageEvent) => onChange((e.data ?? "").trim());

  // Track whether the stream has ever successfully connected. The
  // CLOSED-on-error fallback below must only treat permanent close
  // as a revoke signal if the stream WAS open at some point —
  // otherwise a first-handshake hiccup (server restart timing, a
  // proxy dropping the initial GET, network blip right after login)
  // gets misread as "session revoked" and the user is logged out
  // the moment they sign in.
  let hasConnectedOnce = false;
  es.addEventListener("open", () => { hasConnectedOnce = true; });

  // "ready" is the initial sync event when the connection opens.
  // Receiving it confirms the server accepted us — also marks the
  // hasConnectedOnce flag so even browsers that don't fire `open`
  // reliably are covered.
  es.addEventListener("ready", (e) => {
    hasConnectedOnce = true;
    handleChange(e as MessageEvent);
  });
  // "change" fires every time the server's ETag advances.
  es.addEventListener("change", handleChange as EventListener);
  // "session-revoked" is the server saying "your refresh row is dead;
  // stop trusting this connection." We close immediately so the
  // browser's auto-reconnect can't loop on a 401.
  es.addEventListener("session-revoked", () => {
    es.close();
    onSessionRevoked?.();
  });
  // Belt to the "session-revoked" suspenders: if the browser
  // permanently gives up reconnecting (readyState=CLOSED) AFTER we
  // had a working connection, that almost certainly means the
  // server is now rejecting our cookies — i.e. the session got
  // revoked while we held the stream. Only fire when
  // hasConnectedOnce is true so a first-handshake failure doesn't
  // bounce the user.
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED && hasConnectedOnce) {
      onSessionRevoked?.();
    }
  });
  return () => es.close();
}

export async function runTask(taskId: string, provider?: LLMProvider): Promise<WorkspaceState> {
  const response = await apiFetch(`/api/tasks/${taskId}/run`, {
    method: "POST",
    provider,
    headers: workspaceHeaders(),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "task_run_failed");
  }

  // Mirror the saveWorkspace/fetchWorkspace ETag bookkeeping — the run
  // endpoint returns a workspace that's been mutated server-side (state
  // transitions + new report), so the lastETag we hold for optimistic
  // concurrency is now stale. Pick up the fresh one from the response so
  // the next debounced PUT doesn't 412 and force a wasted re-fetch.
  const etag = response.headers.get("ETag");
  if (etag) lastETag = etag;
  return (await response.json()) as WorkspaceState;
}

// runPlayground is the case-by-case model tester: a one-shot LLM call that
// does not touch workspace state. The user picks the provider, model, and
// prompt; the server returns the raw text + latency. BYOK key (when set) is
// sent via X-LLM-Key, otherwise the server's env-var key is used.
export type PlaygroundResult = {
  text?: string;
  latencyMs: number;
  error?: string;
};

export async function runPlayground(
  provider: LLMProvider,
  model: string,
  prompt: string,
): Promise<PlaygroundResult> {
  const response = await apiFetch("/api/playground", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, prompt }),
    provider,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    return { latencyMs: 0, error: body.error ?? `HTTP ${response.status}` };
  }
  return (await response.json()) as PlaygroundResult;
}

// Upload a file as an attachment on an existing task. Server enforces per-file
// size, total count, and (eventually) per-task quota — surface its error text
// directly so the user sees the real reason on failure.
export async function uploadAttachment(taskId: string, file: File): Promise<TaskAttachment> {
  const fd = new FormData();
  fd.append("file", file);
  const response = await fetch(`/api/tasks/${taskId}/attachments`, {
    method: "POST",
    credentials: "include",
    headers: workspaceHeaders(),
    body: fd,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `upload_failed_${response.status}`);
  }
  return (await response.json()) as TaskAttachment;
}

export async function deleteAttachment(taskId: string, attachmentId: string): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}/attachments/${attachmentId}`, {
    method: "DELETE",
    credentials: "include",
    headers: workspaceHeaders(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `delete_failed_${response.status}`);
  }
}

export async function searchVault(query: string): Promise<WorkspaceState["vaultDocs"]> {
  const response = await fetch(`/api/vault/search?q=${encodeURIComponent(query)}`, {
    credentials: "include",
    headers: workspaceHeaders(),
  });

  if (!response.ok) {
    throw new Error("vault_search_failed");
  }

  const payload = (await response.json()) as VaultSearchResponse;
  return payload.results;
}
