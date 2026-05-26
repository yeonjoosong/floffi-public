// memories — Stage 1 RAG roadmap. Wraps /api/auth/memories CRUD.
//
// 메모리는 사용자별로 묶이고, workspaceId 가 비어 있으면 전역 (사용자가
// 들어가는 모든 워크스페이스), 있으면 그 워크스페이스에서만 LLM 프롬프트에
// inject 된다. 우선순위 (시스템 > 사용자 메모리 > 태스크 지시) 는 서버
// agent.go 가 강제하므로 클라이언트는 CRUD 만 책임진다.

export type UserMemory = {
  id: number;
  userId: string;
  workspaceId?: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

export const MEMORY_MAX_CONTENT_LENGTH = 2048;

async function readJSON<T>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(`unexpected content-type: ${ct}`);
  }
  return (await res.json()) as T;
}

function codeOrStatus(res: Response, body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return `http_${res.status}`;
}

export async function fetchMemories(): Promise<UserMemory[]> {
  const res = await fetch("/api/auth/memories", { credentials: "include" });
  if (!res.ok) throw new Error(`memories list failed: ${res.status}`);
  const body = await readJSON<{ memories: UserMemory[] }>(res);
  return body.memories ?? [];
}

export async function createMemory(content: string, workspaceId?: string): Promise<UserMemory> {
  const res = await fetch("/api/auth/memories", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, workspaceId: workspaceId ?? "" }),
  });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* ignore */ }
    throw new Error(codeOrStatus(res, body));
  }
  return readJSON<UserMemory>(res);
}

export async function updateMemory(id: number, content: string): Promise<UserMemory> {
  const res = await fetch(`/api/auth/memories/${id}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* ignore */ }
    throw new Error(codeOrStatus(res, body));
  }
  return readJSON<UserMemory>(res);
}

export async function deleteMemory(id: number): Promise<void> {
  const res = await fetch(`/api/auth/memories/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`memory delete failed: ${res.status}`);
  }
}
