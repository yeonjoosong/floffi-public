// search — Stage 1-A workspace FTS5 search wrapper.
//
// 사용자 검색은 trust_score 무시 (모든 인덱스 행 보임). 에이전트 프롬프트
// 주입 경로는 서버 내부에서 minTrust=0.7 로 필터하므로 클라이언트는
// 그 분기에 대해 신경 쓰지 않는다.

import { workspaceHeaders } from "./workspaces";

export type SearchHit = {
  sourceType: "task" | "report" | "vault";
  sourceId: string;
  title: string;
  snippet: string;
  trustScore: number;
  updatedAt: number;
  score: number;
};

export async function searchWorkspace(query: string, limit = 20): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(`/api/workspace/search?${params.toString()}`, {
    credentials: "include",
    headers: workspaceHeaders(),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  const body = (await res.json()) as { hits?: SearchHit[] };
  return body.hits ?? [];
}
