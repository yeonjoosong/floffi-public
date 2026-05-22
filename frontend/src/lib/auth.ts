// auth — wrappers around the Phase 3 + 4 endpoints under /api/auth/. Keeps
// React components free of fetch boilerplate and provides typed responses.

import type { Session } from "./types";

async function readJSON<T>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(`unexpected content-type: ${ct}`);
  }
  return (await res.json()) as T;
}

// 이메일 인증 메일 발송 (재발송 포함). 서버는 활성 토큰이 있으면 발송을 생략한다.
export async function startEmailVerify(): Promise<void> {
  const res = await fetch("/api/auth/verify-email/start", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`verify start failed: ${res.status}`);
}

export async function completeEmailVerify(token: string): Promise<void> {
  const res = await fetch("/api/auth/verify-email/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`verify complete failed: ${res.status} ${body}`);
  }
}

export async function startPasswordReset(email: string): Promise<void> {
  const res = await fetch("/api/auth/reset-password/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  // 항상 200을 반환하지만 네트워크 오류는 surfacing.
  if (!res.ok) throw new Error(`reset start failed: ${res.status}`);
}

export async function completePasswordReset(token: string, password: string): Promise<void> {
  const res = await fetch("/api/auth/reset-password/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) {
    let code = "";
    try { code = (await res.json())?.error ?? ""; } catch { /* ignore */ }
    throw new Error(code || `reset complete failed: ${res.status}`);
  }
}

// ── TOTP / recovery ────────────────────────────────────────────────────

export type TOTPSetupResponse = {
  otpauthURI: string;
  secret: string;
};

export async function setupTOTP(): Promise<TOTPSetupResponse> {
  const res = await fetch("/api/auth/totp/setup", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    // Phase 7 — surface the email-verify gate so the modal can render
    // a recoverable "이메일 인증 후 다시 시도" state instead of a generic
    // failure toast.
    let err = "";
    try { err = (await res.json())?.error ?? ""; } catch { /* ignore */ }
    throw new Error(err || `totp setup failed: ${res.status}`);
  }
  return readJSON<TOTPSetupResponse>(res);
}

export async function enableTOTP(code: string): Promise<string[]> {
  const res = await fetch("/api/auth/totp/enable", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    let err = "";
    try { err = (await res.json())?.error ?? ""; } catch { /* ignore */ }
    throw new Error(err || `enable failed: ${res.status}`);
  }
  const body = await readJSON<{ recoveryCodes: string[] }>(res);
  return body.recoveryCodes ?? [];
}

export async function disableTOTP(code: string): Promise<void> {
  const res = await fetch("/api/auth/totp/disable", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    let err = "";
    try { err = (await res.json())?.error ?? ""; } catch { /* ignore */ }
    throw new Error(err || `disable failed: ${res.status}`);
  }
}

export async function verifyTOTPChallenge(challengeToken: string, code: string): Promise<Session> {
  const res = await fetch("/api/auth/totp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeToken, code }),
  });
  if (!res.ok) {
    let err = "";
    try { err = (await res.json())?.error ?? ""; } catch { /* ignore */ }
    throw new Error(err || `verify failed: ${res.status}`);
  }
  return readJSON<Session>(res);
}

export async function verifyRecoveryChallenge(challengeToken: string, code: string): Promise<Session> {
  const res = await fetch("/api/auth/recovery/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeToken, code }),
  });
  if (!res.ok) {
    let err = "";
    try { err = (await res.json())?.error ?? ""; } catch { /* ignore */ }
    throw new Error(err || `verify failed: ${res.status}`);
  }
  return readJSON<Session>(res);
}

export async function regenerateRecoveryCodes(): Promise<string[]> {
  const res = await fetch("/api/auth/recovery/regenerate", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    let err = "";
    try { err = (await res.json())?.error ?? ""; } catch { /* ignore */ }
    throw new Error(err || `regenerate failed: ${res.status}`);
  }
  const body = await readJSON<{ recoveryCodes: string[] }>(res);
  return body.recoveryCodes ?? [];
}

// Phase 6.4 — admin endpoints. The non-admin user 403s on these, so the
// UI mounts the admin panel conditionally on session.isAdmin and we
// don't need additional client-side gating here.

export type AdminUserRow = {
  id: string;
  email: string;
  username: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  lockedUntil: number;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
  // Phase 11 — per-user workspace cap override. null/undefined means
  // "use the global default" (admin UI shows that as a placeholder).
  workspaceCapOverride?: number | null;
};

export async function fetchAdminUsers(): Promise<AdminUserRow[]> {
  const res = await fetch("/api/auth/admin/users", { credentials: "include" });
  if (!res.ok) throw new Error(`admin users failed: ${res.status}`);
  const body = await readJSON<{ users: AdminUserRow[] }>(res);
  return body.users ?? [];
}

export async function adminUnlockUser(userID: string): Promise<void> {
  const res = await fetch(`/api/auth/admin/users/${encodeURIComponent(userID)}/unlock`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`admin unlock failed: ${res.status}`);
}

// adminLockUser blocks the target user from signing in. The server may
// refuse with a specific error code (cannot_lock_self,
// cannot_lock_last_admin, already_locked) — we surface the code on the
// thrown Error so the caller can render a precise message.
export async function adminLockUser(userID: string): Promise<void> {
  return adminUserAction(userID, "lock");
}

// adminGrantAdmin promotes the target to admin. Refusal codes:
//   already_admin, target_locked
export async function adminGrantAdmin(userID: string): Promise<void> {
  return adminUserAction(userID, "grant-admin");
}

// adminSetWorkspaceCap overrides the per-user workspace cap. Pass null
// to clear the override (target falls back to the global default).
export async function adminSetWorkspaceCap(userID: string, cap: number | null): Promise<void> {
  const res = await fetch(`/api/auth/admin/users/${encodeURIComponent(userID)}/workspace-cap`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cap }),
  });
  if (!res.ok) {
    let code = "";
    try {
      const body = await res.json();
      code = typeof body?.error === "string" ? body.error : "";
    } catch { /* */ }
    const err = new Error(code || `workspace-cap failed: ${res.status}`);
    (err as Error & { code?: string }).code = code;
    throw err;
  }
}

// adminRevokeAdmin demotes the target. Refusal codes:
//   cannot_revoke_self, cannot_revoke_last_admin, not_admin
export async function adminRevokeAdmin(userID: string): Promise<void> {
  return adminUserAction(userID, "revoke-admin");
}

// adminUserAction is the shared POST-with-code-error pattern that
// lock/grant/revoke all need. Pulling it out drops three near-duplicate
// fetch blocks and ensures every action surfaces the server's machine-
// readable error code identically.
async function adminUserAction(userID: string, verb: string): Promise<void> {
  const res = await fetch(`/api/auth/admin/users/${encodeURIComponent(userID)}/${verb}`, {
    method: "POST",
    credentials: "include",
  });
  if (res.ok) return;
  let code = "";
  try {
    const body = await res.json();
    code = typeof body?.error === "string" ? body.error : "";
  } catch {
    // body wasn't JSON — leave code blank
  }
  const err = new Error(code || `admin ${verb} failed: ${res.status}`);
  (err as Error & { code?: string }).code = code;
  throw err;
}

// SUPER_ADMIN_ID — 백엔드 auth.SuperAdminID 와 동일한 sentinel. 부트스트랩
// 시드 admin 의 고정 UUID. UI 가 이 행에 destructive 버튼을 노출하지 않게
// 비활성화하는 데 사용. 백엔드가 super_admin_protected 로 거부하긴 하지만
// 사전 비활성으로 클릭 → 에러 토스트의 왕복을 줄인다.
export const SUPER_ADMIN_ID = "00000000-0000-0000-0000-000000000001";

export type AdminResetPasswordResult = {
  resetURL: string;
  expiresAt: number; // unix seconds
  ttlSec: number;
};

// adminIssuePasswordReset asks the server to mint a fresh reset token on
// behalf of `userID`. The raw token appears exactly once in the
// response, never in the DB or in a subsequent fetch — the caller is
// expected to display + let the admin copy it, then drop the value.
export async function adminIssuePasswordReset(userID: string): Promise<AdminResetPasswordResult> {
  const res = await fetch(`/api/auth/admin/users/${encodeURIComponent(userID)}/reset-password`, {
    method: "POST",
    credentials: "include",
  });
  if (res.ok) return readJSON<AdminResetPasswordResult>(res);
  // 다른 admin 액션들과 동일하게 서버의 error 코드를 Error.code 로 부착해
  // 호출자가 super_admin_protected 같은 케이스를 분기할 수 있게.
  let code = "";
  try {
    const body = await res.json();
    code = typeof body?.error === "string" ? body.error : "";
  } catch {
    // body wasn't JSON
  }
  const err = new Error(code || `admin reset-password failed: ${res.status}`);
  (err as Error & { code?: string }).code = code;
  throw err;
}

export type AdminAuditEvent = {
  event: string;
  ip: string;
  userAgent: string;
  at: number;
  meta?: string;
};

export async function fetchAdminAudit(userID: string, limit = 100): Promise<AdminAuditEvent[]> {
  const url = `/api/auth/admin/audit?userId=${encodeURIComponent(userID)}&limit=${limit}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`admin audit failed: ${res.status}`);
  const body = await readJSON<{ events: AdminAuditEvent[] }>(res);
  return body.events ?? [];
}
