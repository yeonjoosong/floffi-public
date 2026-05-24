// reports — Stage 1-B Boss Inbox 승인/디모트 API wrapper.
//
// trust_score 정책:
//   1.0 = 승인 (LLM 프롬프트 inject 허용)
//   0.5 = 자동 생성 (사용자 검색은 보이지만 LLM inject 제외)
//   0.0 = demote (검색 그대로 보이지만 LLM inject 차단)

import { workspaceHeaders } from "./workspaces";

async function postReportAction(reportId: string, verb: "approve" | "demote" | "reset-trust"): Promise<void> {
  const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/${verb}`, {
    method: "POST",
    credentials: "include",
    headers: workspaceHeaders(),
  });
  if (!res.ok) {
    let code = "";
    try { code = ((await res.json()) as { error?: string })?.error ?? ""; } catch { /* ignore */ }
    throw new Error(code || `report ${verb} failed: ${res.status}`);
  }
}

export async function approveReport(reportId: string): Promise<void> {
  return postReportAction(reportId, "approve");
}

export async function demoteReport(reportId: string): Promise<void> {
  return postReportAction(reportId, "demote");
}

export async function resetReportTrust(reportId: string): Promise<void> {
  return postReportAction(reportId, "reset-trust");
}
