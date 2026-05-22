// security — small wrapper around /api/auth/{security,sessions,audit}.
// Keeps the BoardView component free of fetch boilerplate and centralizes
// the response shapes so callers can rely on typed payloads.

export type SecurityPrefs = {
  singleSession: boolean;
};

export type ActiveSession = {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: number;
  lastUsedAt: number;
  isCurrent: boolean;
};

export type AuditEvent = {
  event: string;
  ip: string;
  userAgent: string;
  meta?: string;
  at: number;
};

async function readJSON<T>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(`unexpected content-type: ${ct}`);
  }
  return (await res.json()) as T;
}

export async function fetchSecurityPrefs(): Promise<SecurityPrefs> {
  const res = await fetch("/api/auth/security", { credentials: "include" });
  if (!res.ok) throw new Error(`security GET failed: ${res.status}`);
  return readJSON<SecurityPrefs>(res);
}

export async function updateSecurityPrefs(next: SecurityPrefs): Promise<SecurityPrefs> {
  const res = await fetch("/api/auth/security", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  if (!res.ok) throw new Error(`security POST failed: ${res.status}`);
  return readJSON<SecurityPrefs>(res);
}

export async function fetchActiveSessions(): Promise<ActiveSession[]> {
  const res = await fetch("/api/auth/sessions", { credentials: "include" });
  if (!res.ok) throw new Error(`sessions GET failed: ${res.status}`);
  const body = await readJSON<{ sessions: ActiveSession[] }>(res);
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export async function revokeSession(id: string): Promise<void> {
  const res = await fetch(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`session revoke failed: ${res.status}`);
}

export async function revokeOtherSessions(): Promise<number> {
  const res = await fetch("/api/auth/sessions/revoke-others", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`revoke-others failed: ${res.status}`);
  const body = await readJSON<{ revoked: number }>(res);
  return body.revoked ?? 0;
}

export async function fetchAuditEvents(limit = 50): Promise<AuditEvent[]> {
  const res = await fetch(`/api/auth/audit?limit=${limit}`, { credentials: "include" });
  if (!res.ok) throw new Error(`audit GET failed: ${res.status}`);
  const body = await readJSON<{ events: AuditEvent[] }>(res);
  return Array.isArray(body.events) ? body.events : [];
}

// summarizeUserAgent reduces a verbose UA string down to "<browser> / <os>".
// Simple substring detection only — not robust to spoofed or obscure UAs but
// good enough for the workspace UI badge. Unknowns surface as "Unknown".
export function summarizeUserAgent(ua: string): string {
  if (!ua) return "Unknown";
  const lower = ua.toLowerCase();
  let browser = "Unknown";
  // Order matters: Edge/Edg before Chrome (Edge UA contains both substrings).
  if (lower.includes("edg/") || lower.includes("edge/")) browser = "Edge";
  else if (lower.includes("firefox/")) browser = "Firefox";
  else if (lower.includes("chrome/")) browser = "Chrome";
  else if (lower.includes("safari/")) browser = "Safari";
  let os = "Unknown";
  if (lower.includes("iphone") || lower.includes("ipad") || lower.includes("ios")) os = "iOS";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("mac os") || lower.includes("macintosh")) os = "macOS";
  else if (lower.includes("windows")) os = "Windows";
  else if (lower.includes("linux")) os = "Linux";
  return `${browser} / ${os}`;
}

// formatRelative returns "방금 전" / "N분 전" / "N시간 전" / "N일 전" / 절대 날짜.
// Used in both the session list ("마지막 사용 시각") and the audit log.
export function formatRelative(unixSeconds: number): string {
  if (!unixSeconds || unixSeconds <= 0) return "—";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 60) return "방금 전";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}일 전`;
  // Older than a month — just return the date in YYYY-MM-DD form.
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// AUDIT_EVENT_LABELS maps server event codes to Korean labels surfaced in the
// workspace settings panel's audit log section.
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  login: "로그인",
  logout: "로그아웃",
  signup: "회원가입",
  login_failed: "로그인 실패",
  session_revoked: "세션 종료",
  other_sessions_revoked: "다른 세션 해제",
  security_prefs_changed: "보안 설정 변경",
  // Phase 3
  email_verify_sent: "인증 메일 발송",
  email_verified: "이메일 인증 완료",
  password_reset_requested: "비밀번호 재설정 요청",
  password_reset_completed: "비밀번호 재설정 완료",
  // Phase 4
  totp_setup_started: "2FA 설정 시작",
  totp_enabled: "2FA 활성화",
  totp_disabled: "2FA 해제",
  totp_verified: "2FA 인증",
  recovery_code_used: "복구 코드 사용",
  recovery_codes_regenerated: "복구 코드 재발급",
  // Phase 6.1 — rate limit
  rate_limited: "요청 차단(rate limit)",
  // Phase 6.2 — account lock escalation
  account_locked_temporary: "계정 잠금(재설정 필요)",
  account_locked_permanent: "계정 영구 잠금",
  account_unlocked: "계정 잠금 해제",
  account_unlocked_via_reset: "비밀번호 재설정으로 잠금 해제",
  password_reset_issued_by_admin: "관리자가 비밀번호 재설정 링크 발급",
  account_locked_by_admin: "관리자가 계정 잠금",
  admin_granted: "관리자 권한 부여됨",
  admin_revoked: "관리자 권한 해제됨",
  // Phase 6.3 — new device alert
  new_device_login: "새 기기에서 로그인",
  // Phase 6.7 — kick notification (last-wins single_session)
  session_kick_notified: "다른 곳 로그인으로 세션 종료 알림",
  // Phase 7 — account deletion
  account_deleted: "회원 탈퇴",
  account_delete_failed: "회원 탈퇴 시도 실패",
};

export function labelForAuditEvent(event: string): string {
  return AUDIT_EVENT_LABELS[event] ?? event;
}
