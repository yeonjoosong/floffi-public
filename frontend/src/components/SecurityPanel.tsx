import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalCloseButton } from "./ModalCloseButton";
import { useEscapeClose } from "../lib/escapeStack";
import {
  fetchActiveSessions,
  fetchAuditEvents,
  fetchSecurityPrefs,
  formatRelative,
  labelForAuditEvent,
  revokeSession,
  summarizeUserAgent,
  updateSecurityPrefs,
  type ActiveSession,
  type AuditEvent,
  type SecurityPrefs,
} from "../lib/security";
import {
  disableTOTP,
  regenerateRecoveryCodes,
  fetchAdminUsers,
  adminUnlockUser,
  adminLockUser,
  adminGrantAdmin,
  adminRevokeAdmin,
  adminIssuePasswordReset,
  adminSetWorkspaceCap,
  SUPER_ADMIN_ID,
  type AdminUserRow,
  type AdminResetPasswordResult,
} from "../lib/auth";
import { TOTPSetupModal } from "./TOTPSetupModal";
import { Toggle } from "./BoardViewPrimitives";

// Props let SecurityPanel hide/show the TOTP block based on the current
// session — passing the flag from App keeps the component oblivious to
// where the session comes from (cookies, polling, etc.).
type SecurityPanelProps = {
  totpEnabled: boolean;
  // 이메일 인증 상태 — 보안 탭 상단의 전용 "이메일 인증" 섹션에서
  // 표시한다. TOTP 활성화와는 독립이며(별개 기능), 인증 메일 재발송
  // 트리거도 여기에서 일어난다. 상단 배너(EmailVerifyBanner)는 이와
  // 별도로 BoardView 상단에 항상 노출.
  emailVerified: boolean;
  onResendVerifyEmail: () => void;
  onTotpChanged: () => void;
  // Phase 7 — 회원 탈퇴 완료 시 호출. 상위가 세션 상태를 비우고
  // 로그인 화면으로 보낸다. 이 panel 내에서는 fetch 만 책임.
  onAccountDeleted: () => void;
  // 회원 탈퇴 모달의 type-to-confirm 가드에 표시·검증할 자기 이메일.
  // 빈 문자열이면 모달은 fallback 으로 "회원가입에 사용한 이메일" 이라는
  // 일반 안내를 보여주지만, 서버는 user.Email 과 비교하므로 그래도 정확히
  // 입력해야 통과 — 어차피 빈 케이스는 정상 세션에서는 발생하지 않는다.
  sessionEmail: string;
  // Phase 6.4 — when true, mount the admin section. Plain users
  // never see it (and the backend rejects the routes anyway).
  isAdmin?: boolean;
};

// SecurityPanel — renders three workspace-settings sections:
//   1) 단일 세션 토글 (single_session 옵션)
//   2) 활성 세션 목록 (현재 사용자의 미폐기 refresh_sessions)
//   3) 보안 활동 기록 (audit_log)
//
// 각 데이터는 패널이 마운트될 때 한 번 가져오고, 사용자 액션 후 필요한
// 슬라이스만 다시 가져온다. 백그라운드 폴링은 하지 않는다 — 워크스페이스
// 사이드 패널은 자주 열리지 않으므로 매번 fresh 로 충분하다.

type SectionProps = { title: string; children: React.ReactNode };
function Section(props: SectionProps) {
  return (
    <div>
      <p className="mb-2.5 text-[11px] font-black uppercase tracking-wider text-t3">{props.title}</p>
      {props.children}
    </div>
  );
}

export function SecurityPanel(props: SecurityPanelProps) {
  const [prefs, setPrefs] = useState<SecurityPrefs | null>(null);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TOTP UI state
  const [totpModalOpen, setTotpModalOpen] = useState(false);
  const [disableCode, setDisableCode] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [p, s, a] = await Promise.all([
        fetchSecurityPrefs(),
        fetchActiveSessions(),
        fetchAuditEvents(50),
      ]);
      setPrefs(p);
      setSessions(s);
      setEvents(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "보안 정보를 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function toggleSingleSession() {
    if (!prefs || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await updateSecurityPrefs({ singleSession: !prefs.singleSession });
      setPrefs(next);
      // 설정 변경은 감사 로그에도 남으므로 활동 기록을 갱신.
      const a = await fetchAuditEvents(50);
      setEvents(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "설정 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function onRevokeSession(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await revokeSession(id);
      const [s, a] = await Promise.all([fetchActiveSessions(), fetchAuditEvents(50)]);
      setSessions(s);
      setEvents(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "세션 해제에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshAudit() {
    setError(null);
    try {
      const a = await fetchAuditEvents(50);
      setEvents(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "활동 기록을 가져오지 못했습니다.");
    }
  }

  async function handleDisableTOTP() {
    if (!disableCode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await disableTOTP(disableCode.trim());
      setDisableOpen(false);
      setDisableCode("");
      props.onTotpChanged();
      const a = await fetchAuditEvents(50);
      setEvents(a);
    } catch (e) {
      setError(e instanceof Error && e.message.includes("invalid_code")
        ? "코드가 일치하지 않아요."
        : "2FA 해제에 실패했어요.");
    } finally {
      setBusy(false);
    }
  }

  // 재발급은 step-up이 필요한데, 단순화를 위해 일단 그냥 호출하고 서버가
  // 거부하면 사용자에게 다시 인증하도록 안내한다. (5분 윈도우 안이면 OK.)
  async function handleRegenerateRecovery() {
    setBusy(true);
    setError(null);
    try {
      const codes = await regenerateRecoveryCodes();
      setNewRecoveryCodes(codes);
      setRegenOpen(false);
      const a = await fetchAuditEvents(50);
      setEvents(a);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("mfa_required") || msg.includes("forbidden")) {
        setError("최근 5분 내 2단계 인증이 필요해요. 한 번 로그아웃 후 다시 로그인해주세요.");
      } else {
        setError("복구 코드 재발급에 실패했어요.");
      }
    } finally {
      setBusy(false);
    }
  }

  function downloadCodes(codes: string[]) {
    const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "floffi-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {/* 이메일 인증 — TOTP 와 무관한 독립 섹션. 인증 완료/미완료를 표시하고
          미완료 상태에서는 "인증 메일 다시 보내기" CTA 노출. 상단 배너(BoardView
          의 EmailVerifyBanner) 와 중복되어 보이지만, 사용자가 배너를 닫은
          뒤에도 보안 탭에서 재발송할 수 있는 영구 경로를 제공. */}
      <Section title="이메일 인증">
        {props.emailVerified ? (
          <div data-role="card" className="rounded-xl border border-bd/10 bg-s2 px-3 py-2.5">
            <p className="text-sm font-bold text-emerald-500">인증 완료</p>
            <p className="mt-1 text-[11px] leading-snug text-t3">
              가입 시 입력한 이메일 소유가 확인되었어요. 비밀번호 재설정 메일이 정상적으로 도착해요.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div data-role="card" className="rounded-xl border border-bd/10 bg-s2 px-3 py-2.5">
              <p className="text-sm font-bold text-amber-500">미인증</p>
              <p className="mt-1 text-[11px] leading-snug text-t3">
                가입 직후 발송된 인증 메일의 링크를 눌러주세요. 메일이 안 보이면 스팸함도 확인해주세요.
              </p>
            </div>
            <button
              type="button"
              onClick={props.onResendVerifyEmail}
              className="w-full rounded-md border border-ac/30 bg-ac/15 px-2 py-1.5 text-[11px] font-bold text-ac transition hover:bg-ac/25"
            >
              인증 메일 다시 보내기
            </button>
          </div>
        )}
      </Section>

      <Section title="2단계 인증">
        {props.totpEnabled ? (
          <div className="space-y-2">
            <div data-role="card" className="rounded-xl border border-bd/10 bg-s2 px-3 py-2.5">
              <p className="text-sm font-bold text-t1">활성화됨</p>
              <p className="mt-1 text-[11px] leading-snug text-t3">
                로그인 시 인증 앱이 표시하는 6자리 코드 또는 복구 코드를 입력해야 해요.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRegenOpen(true)}
                disabled={busy}
                className="flex-1 rounded-md border border-bd/15 bg-base shadow-[inset_0_2px_5px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.03)] px-2 py-1.5 text-[11px] font-bold text-t2 transition hover:bg-s3 hover:text-t1 disabled:opacity-50"
              >
                복구 코드 재발급
              </button>
              <button
                type="button"
                onClick={() => setDisableOpen(true)}
                disabled={busy}
                className="flex-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
              >
                2단계 인증 해제
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div data-role="card" className="rounded-xl border border-bd/10 bg-s2 px-3 py-2.5">
              <p className="text-sm font-bold text-t1">비활성</p>
              <p className="mt-1 text-[11px] leading-snug text-t3">
                인증 앱 + 복구 코드로 로그인 보안을 한 단계 강화할 수 있어요.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTotpModalOpen(true)}
              className="w-full rounded-md border border-ac/30 bg-ac/15 px-2 py-1.5 text-[11px] font-bold text-ac transition hover:bg-ac/25"
            >
              2단계 인증 설정
            </button>
          </div>
        )}

        {disableOpen ? (
          <div data-role="card" className="mt-3 rounded-xl border border-bd/10 bg-s2 p-3">
            <p className="text-[11px] font-black uppercase tracking-wider text-t3">해제 확인용 코드</p>
            <p className="mt-1 text-[11px] text-t3">현재 TOTP 6자리 또는 복구 코드 한 개를 입력해주세요.</p>
            <input
              type="text"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
              className="mt-2 w-full rounded-md border border-bd/10 bg-s1 px-2 py-1.5 text-xs text-t1 outline-none focus:outline-none"
              placeholder="123 456 또는 XXXX-XXXX"
            />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => { setDisableOpen(false); setDisableCode(""); }}
                className="flex-1 rounded-md border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t2">취소</button>
              <button type="button" onClick={() => void handleDisableTOTP()} disabled={busy || !disableCode.trim()}
                className="flex-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] font-bold text-red-300 disabled:opacity-50">해제</button>
            </div>
          </div>
        ) : null}

        {regenOpen ? (
          <div data-role="card" className="mt-3 rounded-xl border border-bd/10 bg-s2 p-3">
            <p className="text-[11px] font-black uppercase tracking-wider text-t3">복구 코드 재발급</p>
            <p className="mt-1 text-[11px] text-t3">기존 복구 코드 10개는 모두 무효화됩니다. 계속할까요?</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => setRegenOpen(false)}
                className="flex-1 rounded-md border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t2">취소</button>
              <button type="button" onClick={() => void handleRegenerateRecovery()} disabled={busy}
                className="flex-1 rounded-md border border-ac/30 bg-ac/15 px-2 py-1 text-[11px] font-bold text-ac disabled:opacity-50">재발급</button>
            </div>
          </div>
        ) : null}

        {newRecoveryCodes ? (
          <div data-role="card" className="mt-3 rounded-xl border border-bd/10 bg-s2 p-3">
            <p className="text-[11px] font-black uppercase tracking-wider text-t3">새 복구 코드</p>
            <p className="mt-1 text-[11px] text-t3">지금 안전한 곳에 저장해주세요 — 다시 보여드릴 수 없습니다.</p>
            <div className="mt-2 grid grid-cols-2 gap-1">
              {newRecoveryCodes.map((c) => (
                <p key={c} className="text-center font-mono text-xs tracking-wider text-t1">{c}</p>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => downloadCodes(newRecoveryCodes)}
                className="flex-1 rounded-md border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t2">다운로드</button>
              <button type="button" onClick={() => setNewRecoveryCodes(null)}
                className="flex-1 rounded-md border border-ac/30 bg-ac/15 px-2 py-1 text-[11px] font-bold text-ac">저장했어요</button>
            </div>
          </div>
        ) : null}
      </Section>

      <TOTPSetupModal
        open={totpModalOpen}
        onClose={() => setTotpModalOpen(false)}
        onEnabled={() => { props.onTotpChanged(); void loadAll(); }}
      />

      <Section title="보안">
        <div className="space-y-3">
          <div data-role="card" className="rounded-xl border border-bd/10 bg-s2 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold text-t1">한 기기에서만 로그인</p>
              {/* Use the shared Toggle component so this switch picks up
                  the same symmetric knob travel + per-theme styling
                  (toy chassis tints, win98 checkbox repaint) as every
                  other toggle in the app. The previous inline switch
                  was asymmetric (4px right gap vs 2px left gap) and
                  also skipped theme rules because it had no
                  data-role="toggle". */}
              <Toggle
                on={!!prefs?.singleSession}
                onClick={() => void toggleSingleSession()}
                disabled={!prefs || busy}
              />
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-t3">
              새 기기에서 로그인하면 다른 기기의 세션이 모두 해제됩니다. 기본 활성 — 여러 기기 동시 사용을 허용하려면 OFF.
            </p>
          </div>
          {error ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-400">{error}</p>
          ) : null}
        </div>
      </Section>

      <Section title="활성 세션">
        {sessions.length === 0 ? (
          <p className="text-[11px] text-t3">활성 세션이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => {
              const ua = summarizeUserAgent(s.userAgent);
              return (
                <li key={s.id} data-role="card" className="rounded-xl border border-bd/10 bg-s2 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-t1">{ua}</p>
                      <p className="mt-0.5 text-[11px] text-t3">
                        {s.ip || "—"} · 마지막 사용 {formatRelative(s.lastUsedAt)}
                      </p>
                    </div>
                    {s.isCurrent ? (
                      <span className="shrink-0 rounded-md border border-ac/30 bg-ac/15 px-1.5 py-0.5 text-[10px] font-bold text-ac">현재</span>
                    ) : (
                      <button type="button" onClick={() => void onRevokeSession(s.id)}
                        disabled={busy}
                        className="shrink-0 rounded-md border border-bd/10 bg-s1 px-2 py-0.5 text-[10.5px] font-bold text-t2 transition hover:bg-s3 hover:text-t1 disabled:opacity-50"
                      >
                        해제
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Inline the title + 새로고침 button so they share a row —
          can't use <Section> wrapper here because Section always
          stacks the title above its children. */}
      <div>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <p className="text-[11px] font-black uppercase tracking-wider text-t3">보안 활동 기록</p>
          <button type="button" onClick={() => void refreshAudit()}
            className="rounded-md border border-bd/15 bg-s2 px-2 py-0.5 text-[10.5px] font-bold text-t2 transition hover:bg-s3 hover:text-t1"
          >
            새로고침
          </button>
        </div>
        {events.length === 0 ? (
          <p className="text-[11px] text-t3">기록 없음</p>
        ) : (
          /* Wrap the scrolling <ul> in a rounded + overflow-hidden div
             so the scrollbar gets clipped to the rounded corner
             instead of sticking out past the radius. */
          <div data-role="card" className="overflow-hidden rounded-xl border border-bd/10 bg-s2">
            <ul className="max-h-64 overflow-y-auto space-y-1 p-2">
              {events.map((e, idx) => (
                <li key={`${e.at}-${idx}`} className="text-[11px] leading-snug text-t2">
                  <span className="font-bold text-t1">{labelForAuditEvent(e.event)}</span>
                  <span className="text-t3"> · {formatRelative(e.at)}</span>
                  <span className="text-t3"> · {e.ip || "—"}</span>
                  <span className="text-t3"> · {summarizeUserAgent(e.userAgent)}</span>
                  {e.meta ? <span className="text-t3"> · {e.meta}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Phase 7 — 위험 영역. 회원 탈퇴는 다른 보안 액션과 시각적으로
          구분되어야 사용자가 실수로 누를 일이 없으므로, 빨강 톤 카드 +
          전용 제목 + 모달 확인 흐름의 3단 가드를 둔다. */}
      <DangerZoneSection
        totpEnabled={props.totpEnabled}
        sessionEmail={props.sessionEmail}
        onAccountDeleted={props.onAccountDeleted}
      />

      {/* Phase 6.4 — admin section. Mounts only when the session
          reports isAdmin=true. The backend rejects the routes for
          non-admin users anyway, so this is purely a UI cleanup. */}
      {props.isAdmin ? <AdminUsersSection selfEmail={props.sessionEmail} /> : null}
    </>
  );
}

// ── DangerZoneSection ────────────────────────────────────────────────
// 보안 탭 하단 "위험 영역" 카드. 회원 탈퇴 버튼 한 개를 노출하고,
// 클릭 시 비밀번호 + (TOTP) + 타입투컨펌 모달을 띄운다. GitHub Danger
// Zone + 카카오/네이버 회원탈퇴 + Apple ID 모달 패턴의 절충안.
function DangerZoneSection(props: { totpEnabled: boolean; sessionEmail: string; onAccountDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Section title="위험 영역">
        <div data-role="card" className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-3">
          <p className="text-sm font-bold text-t1">회원 탈퇴</p>
          <p className="mt-1 text-[11px] leading-snug text-t3">
            계정과 로그인 정보, 활성 세션, 2단계 인증 설정이 모두 영구 삭제됩니다. 한 번 탈퇴하면 되돌릴 수 없어요.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2.5 w-full rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-300 transition hover:bg-red-500/20"
          >
            회원 탈퇴
          </button>
        </div>
      </Section>
      {open ? (
        <DeleteAccountModal
          totpEnabled={props.totpEnabled}
          sessionEmail={props.sessionEmail}
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); props.onAccountDeleted(); }}
        />
      ) : null}
    </>
  );
}

// 탈퇴 확인 모달 — 비밀번호 + (TOTP, 활성 시) + "탈퇴" 정확 입력의
// 3-필드 게이트. 서버도 동일한 검증을 수행하므로 클라이언트는 사용자
// 마찰을 줄이는 게 목적 — 버튼 활성화 조건을 명확히 보여줘 헛클릭 방지.
function DeleteAccountModal(props: {
  totpEnabled: boolean;
  sessionEmail: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEscapeClose(true, props.onClose);

  // 이메일 정확 일치(케이스 무시) — 서버 검증과 동일한 규칙. trim 만
  // 해주고 lowercase 비교. 빈 sessionEmail (정상 세션에선 발생하지 않지만
  // 방어용) 일 때는 일치 판정을 하지 못하므로 버튼이 영원히 비활성 —
  // 사용자가 모달을 닫고 세션 재로딩 후 다시 시도하는 흐름.
  const confirmMatches =
    props.sessionEmail !== "" &&
    confirm.trim().toLowerCase() === props.sessionEmail.toLowerCase();

  const canSubmit =
    password.length > 0 &&
    confirmMatches &&
    (!props.totpEnabled || totpCode.trim().length > 0) &&
    !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/auth/account/delete", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          totpCode: props.totpEnabled ? totpCode.trim() : "",
          confirm: confirm.trim(),
        }),
      });
      if (!res.ok) {
        let code = "";
        try { code = (await res.json())?.error ?? ""; } catch { /* ignore */ }
        const map: Record<string, string> = {
          invalid_password: "비밀번호가 일치하지 않아요.",
          invalid_totp: "2단계 인증 코드가 올바르지 않아요.",
          totp_required: "2단계 인증 코드를 입력해주세요.",
          confirm_mismatch: "본인 이메일을 정확히 입력해주세요.",
          unauthorized: "세션이 만료됐어요. 다시 로그인 후 시도해주세요.",
        };
        setError(map[code] ?? "탈퇴 요청에 실패했어요. 잠시 후 다시 시도해주세요.");
        return;
      }
      props.onDone();
    } catch {
      setError("네트워크 오류로 탈퇴 요청에 실패했어요.");
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      {/* 모달 백드롭은 장식용 — 사용자가 비밀번호를 입력 중에 실수로
          밖을 클릭해도 드래프트가 날아가지 않게 close 는 X / ESC / 닫기
          버튼으로만 한다. */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-hidden />
      <div
        data-role="modal-window"
        className="absolute left-1/2 top-1/2 w-[min(94vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border-2 border-red-500/30 bg-s1 shadow-2xl"
      >
        <ModalCloseButton onClose={props.onClose} />
        <div data-role="modal-titlebar" className="flex items-center justify-between border-b border-bd/10 px-5 py-3 pr-12">
          <h3 className="text-base font-black text-red-400">회원 탈퇴</h3>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5">
            <p className="text-[12px] font-bold text-t1">탈퇴 시 다음 데이터가 영구 삭제됩니다:</p>
            <ul className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-t2">
              <li>· 로그인 자격 (이메일, 비밀번호 해시, 닉네임)</li>
              <li>· 활성/만료 세션 및 새 기기 로그인 기록</li>
              <li>· 2단계 인증 secret 과 복구 코드</li>
              <li>· 이메일 인증/재설정 토큰</li>
            </ul>
            <p className="mt-2 text-[11px] leading-snug text-t3">
              감사 로그(audit_log) 의 과거 이벤트는 포렌식 목적으로 익명화된 형태로 보존됩니다.
              한 번 탈퇴하면 되돌릴 수 없고, 같은 이메일로 다시 가입할 수 있어요.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-t3">비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-md border border-bd/15 bg-s2 px-2.5 py-1.5 text-sm text-t1 outline-none focus:outline-none"
              placeholder="현재 비밀번호"
            />
          </div>

          {props.totpEnabled ? (
            <div>
              <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-t3">2단계 인증 코드</label>
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-full rounded-md border border-bd/15 bg-s2 px-2.5 py-1.5 text-sm tracking-widest text-t1 outline-none focus:outline-none"
                placeholder="123 456"
              />
              <p className="mt-1 text-[11px] text-t3">인증 앱이 표시하는 6자리 코드 또는 복구 코드 한 개.</p>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-t3">
              확인을 위해 본인 이메일을 입력
            </label>
            <input
              type="email"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              className="w-full rounded-md border border-bd/15 bg-s2 px-2.5 py-1.5 text-sm text-t1 outline-none focus:outline-none"
              placeholder={props.sessionEmail || "you@example.com"}
            />
            {props.sessionEmail ? (
              <p className="mt-1 text-[11px] text-t3">
                현재 계정: <span className="font-mono text-t2">{props.sessionEmail}</span>
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="text-[12px] font-bold text-red-400">{error}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-bd/10 px-5 py-3">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-md border border-bd/15 bg-s2 px-3 py-1.5 text-[12px] font-bold text-t2 transition hover:bg-s3 hover:text-t1"
          >
            닫기
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-md border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-[12px] font-bold text-red-300 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "탈퇴 처리 중..." : "탈퇴하기"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// AdminUsersSection — small admin panel: lists every user, highlights
// the locked ones, and offers an unlock button. Kept inside this file
// (rather than a new component) because the surface is small and it
// shares the existing Section/labelForAuditEvent styling.
function AdminUsersSection(props: { selfEmail: string }) {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // resetIssued holds the result of the latest admin-issued reset so the
  // modal can render the one-time link. We keep the target username
  // alongside it so the modal can name who the link is for.
  const [resetIssued, setResetIssued] = useState<
    | (AdminResetPasswordResult & { username: string; email: string })
    | null
  >(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await fetchAdminUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : "사용자 목록 조회 실패");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function unlock(id: string) {
    setBusy(true);
    setError(null);
    try {
      await adminUnlockUser(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "잠금 해제 실패");
    } finally {
      setBusy(false);
    }
  }

  async function issueReset(u: AdminUserRow) {
    setBusy(true);
    setError(null);
    try {
      const result = await adminIssuePasswordReset(u.id);
      setResetIssued({ ...result, username: u.username, email: u.email });
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? "";
      if (code === "super_admin_protected") {
        setError("최초 관리자 계정은 다른 관리자가 조작할 수 없어요.");
      } else {
        setError(e instanceof Error ? e.message : "비밀번호 재설정 링크 발급 실패");
      }
    } finally {
      setBusy(false);
    }
  }

  // lock 의 서버 응답 에러 코드를 사용자-친화 메시지로 매핑.
  // cannot_lock_self / cannot_lock_last_admin / already_locked 는 모두
  // 가드 거절이라 의미가 다르고, generic "잠금 실패" 로 묶으면 admin 이
  // 왜 안 됐는지 파악할 수 없다.
  function lockErrorMessage(code: string): string {
    switch (code) {
      case "super_admin_protected":
        return "최초 관리자 계정은 다른 관리자가 조작할 수 없어요.";
      case "cannot_lock_self":
        return "본인 계정은 잠글 수 없어요.";
      case "cannot_lock_last_admin":
        return "마지막으로 남은 관리자 계정은 잠글 수 없어요. 다른 관리자를 먼저 추가해주세요.";
      case "already_locked":
        return "이미 잠긴 계정이에요.";
      default:
        return code ? `잠금 실패 (${code})` : "잠금 실패";
    }
  }

  async function lock(u: AdminUserRow) {
    setBusy(true);
    setError(null);
    try {
      await adminLockUser(u.id);
      await load();
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? "";
      setError(lockErrorMessage(code));
    } finally {
      setBusy(false);
    }
  }

  // pendingGrant — admin 권한 부여는 blast radius 가 큰 동작이라(부여
  // 받은 사용자가 즉시 다른 admin 을 강등/잠금할 수 있음) 한 번 더
  // 확인을 받는다. 강등은 가드(본인/마지막) 외에 위험이 작아서 confirm
  // 없이 즉시 실행.
  const [pendingGrant, setPendingGrant] = useState<AdminUserRow | null>(null);

  function adminToggleErrorMessage(code: string, grant: boolean): string {
    switch (code) {
      case "super_admin_protected":
        return "최초 관리자 계정은 다른 관리자가 조작할 수 없어요.";
      case "already_admin":
        return "이미 관리자 계정이에요.";
      case "target_locked":
        return "잠긴 사용자는 관리자로 승격할 수 없어요. 먼저 잠금을 풀어주세요.";
      case "cannot_revoke_self":
        return "본인의 관리자 권한은 해제할 수 없어요. 다른 관리자가 처리해야 해요.";
      case "cannot_revoke_last_admin":
        return "마지막으로 남은 관리자의 권한은 해제할 수 없어요.";
      case "not_admin":
        return "관리자가 아닌 사용자예요.";
      default:
        if (code) return `${grant ? "권한 부여" : "권한 해제"} 실패 (${code})`;
        return grant ? "권한 부여 실패" : "권한 해제 실패";
    }
  }

  async function grantAdmin(u: AdminUserRow) {
    setBusy(true);
    setError(null);
    try {
      await adminGrantAdmin(u.id);
      await load();
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? "";
      setError(adminToggleErrorMessage(code, true));
    } finally {
      setBusy(false);
      setPendingGrant(null);
    }
  }

  async function revokeAdmin(u: AdminUserRow) {
    setBusy(true);
    setError(null);
    try {
      await adminRevokeAdmin(u.id);
      await load();
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? "";
      setError(adminToggleErrorMessage(code, false));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="관리자 — 사용자 목록">
      <p className="mb-2 text-[11px] leading-relaxed text-t3">
        <span className="font-bold text-red-500">잠금</span> 은 로그인을 즉시 차단(의심 사용·퇴사 등),
        {" "}
        <span className="font-bold text-t2">잠금 해제</span> 는 비밀번호를 알고 있는 사용자가 잠겼을 때,
        {" "}
        <span className="font-bold text-t2">비밀번호 재설정</span> 은 비밀번호를 잊은 사용자에게 새 비밀번호 설정 링크를 발급할 때,
        {" "}
        <span className="font-bold text-ac">권한 부여</span>/<span className="font-bold text-t2">권한 해제</span> 는 관리자 권한을 토글할 때 사용해요.
      </p>
      {error ? <p className="mb-2 text-[11px] text-red-500">{error}</p> : null}
      {users.length === 0 ? (
        <p className="text-[11px] text-t3">사용자 없음</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto space-y-1 rounded-xl border border-bd/10 bg-s2 p-2"
            data-role="card">
          {users.map((u) => {
            const locked = u.lockedUntil !== 0;
            const permanent = u.lockedUntil === -1;
            const isSelf = u.email.toLowerCase() === props.selfEmail.toLowerCase();
            // 부트스트랩 super admin 은 본인 외 누구의 destructive 액션도
            // 거부된다. 백엔드가 super_admin_protected 로 차단하지만,
            // 행 자체에서 위험 버튼을 비활성화해 클릭→에러 토스트 왕복을
            // 줄인다. isSelf 인 경우(본인이 super admin) 는 기존 본인
            // 가드(cannot_lock_self / cannot_revoke_self 등)가 그대로
            // 처리하므로 super-admin 가드와 중복돼도 무해.
            const isSuper = u.id === SUPER_ADMIN_ID;
            const protectedByOther = isSuper && !isSelf;
            return (
              <li key={u.id} className="text-[11px] leading-snug">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-t1">{u.username}</span>
                  <span className="text-t3">{u.email}</span>
                  {isSuper ? <span className="rounded bg-ac/30 px-1 text-[10px] font-bold text-ac" title="최초 관리자 — 다른 관리자가 잠금/권한 해제/비밀번호 재설정 등 어떤 조작도 할 수 없어요.">super admin</span> : null}
                  {u.isAdmin && !isSuper ? <span className="rounded bg-ac/20 px-1 text-[10px] font-bold text-ac">admin</span> : null}
                  {u.totpEnabled ? <span className="rounded bg-bd/10 px-1 text-[10px] text-t2">2FA</span> : null}
                  {locked ? (
                    <span className={`rounded px-1 text-[10px] font-bold ${permanent ? "bg-red-600/20 text-red-500" : "bg-amber-500/20 text-amber-500"}`}>
                      {permanent ? "영구 잠금" : "일시 잠금"}
                    </span>
                  ) : null}
                  <div className="ml-auto flex gap-1">
                    {locked ? (
                      <button
                        type="button"
                        disabled={busy || protectedByOther}
                        onClick={() => void unlock(u.id)}
                        title={protectedByOther
                          ? "최초 관리자 계정은 다른 관리자가 조작할 수 없어요."
                          : "비밀번호를 알고 있는 사용자용 — 기존 비밀번호로 다시 로그인할 수 있게 잠금만 풀어요. 비밀번호를 잊었다면 [비밀번호 재설정] 을 누르세요."}
                        className="rounded-md border border-ac/40 bg-ac/15 px-2 py-0.5 text-[10px] font-bold text-ac transition hover:bg-ac/25 disabled:opacity-50"
                      >잠금 해제</button>
                    ) : (
                      // 본인 행은 잠금 버튼을 비활성화한다. 서버가 cannot_lock_self
                      // 로 거부하지만, 클라이언트에서 미리 막아 두면 클릭 후
                      // 에러 토스트를 보는 마찰이 없어진다.
                      <button
                        type="button"
                        disabled={busy || isSelf || protectedByOther}
                        onClick={() => void lock(u)}
                        title={protectedByOther
                          ? "최초 관리자 계정은 다른 관리자가 조작할 수 없어요."
                          : isSelf
                          ? "본인 계정은 잠글 수 없어요."
                          : "이 사용자의 로그인을 즉시 차단해요. 활성 세션도 모두 종료됩니다."}
                        className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-500 transition hover:bg-red-500/20 disabled:opacity-40"
                      >잠금</button>
                    )}
                    <button
                      type="button"
                      disabled={busy || protectedByOther}
                      onClick={() => void issueReset(u)}
                      title={protectedByOther
                        ? "최초 관리자 계정은 다른 관리자가 조작할 수 없어요."
                        : "비밀번호를 잊은 사용자용 — 새 비밀번호를 설정할 수 있는 1회용 링크를 발급해요. 사용자가 재설정을 완료하면 잠금도 함께 자동 해제돼요."}
                      className="rounded-md border border-bd/30 bg-s1 px-2 py-0.5 text-[10px] font-bold text-t2 transition hover:bg-bd/10 disabled:opacity-50"
                    >비밀번호 재설정</button>
                    {(() => {
                      // admin 토글: isAdmin → "권한 해제" / 아니면 "권한 부여".
                      // 본인 행에서 "권한 해제" 는 비활성 (서버 cannot_revoke_self),
                      // 잠긴 사용자에 대한 "권한 부여" 도 비활성 (서버 target_locked),
                      // 다른 admin 이 보는 super-admin 행은 양쪽 다 비활성.
                      if (u.isAdmin) {
                        return (
                          <button
                            type="button"
                            disabled={busy || isSelf || protectedByOther}
                            onClick={() => void revokeAdmin(u)}
                            title={protectedByOther
                              ? "최초 관리자 계정은 다른 관리자가 조작할 수 없어요."
                              : isSelf
                              ? "본인의 관리자 권한은 해제할 수 없어요."
                              : "이 관리자의 권한을 해제해 일반 사용자로 되돌려요."}
                            className="rounded-md border border-bd/30 bg-s1 px-2 py-0.5 text-[10px] font-bold text-t2 transition hover:bg-bd/10 disabled:opacity-40"
                          >권한 해제</button>
                        );
                      }
                      return (
                        <button
                          type="button"
                          disabled={busy || locked || protectedByOther}
                          onClick={() => setPendingGrant(u)}
                          title={protectedByOther
                            ? "최초 관리자 계정은 다른 관리자가 조작할 수 없어요."
                            : locked
                            ? "잠긴 사용자에게는 관리자 권한을 부여할 수 없어요."
                            : "이 사용자를 관리자로 승격해요. 승격 후엔 즉시 사용자 잠금/해제·권한 부여가 가능해지므로 신중히 확인 후 진행하세요."}
                          className="rounded-md border border-ac/40 bg-ac/15 px-2 py-0.5 text-[10px] font-bold text-ac transition hover:bg-ac/25 disabled:opacity-40"
                        >권한 부여</button>
                      );
                    })()}
                  </div>
                </div>
                {/* Phase 11 — per-user workspace cap override. Owner can
                    bump a specific operator's limit without raising the
                    global default. Hidden for super admin (their cap is
                    effectively unlimited operationally). */}
                {!isSuper ? (
                  <WorkspaceCapEditor user={u} onChanged={() => void load()} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {resetIssued ? (
        <AdminResetIssuedModal
          username={resetIssued.username}
          email={resetIssued.email}
          resetURL={resetIssued.resetURL}
          expiresAt={resetIssued.expiresAt}
          ttlSec={resetIssued.ttlSec}
          onClose={() => setResetIssued(null)}
        />
      ) : null}
      {pendingGrant ? (
        <AdminGrantConfirmModal
          username={pendingGrant.username}
          email={pendingGrant.email}
          busy={busy}
          onCancel={() => setPendingGrant(null)}
          onConfirm={() => void grantAdmin(pendingGrant)}
        />
      ) : null}
    </Section>
  );
}

// AdminGrantConfirmModal — admin 부여는 한 번 클릭으로 끝나기엔 영향이
// 너무 크다(부여받은 사람이 즉시 다른 admin 을 강등·잠금할 수 있음).
// 그래서 GitHub/GitLab 의 "Make admin" 패턴처럼 사용자 이름을 한 번
// 더 보여주는 confirm 단계를 둔다. 강등은 이 모달 없이 즉시 실행 —
// 가드(본인/마지막) 외에 위험이 작아서.
function AdminGrantConfirmModal(props: {
  username: string;
  email: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEscapeClose(true, props.onCancel);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div data-role="modal-window" className="relative w-full max-w-sm rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
        <ModalCloseButton onClose={props.onCancel} />
        <div data-role="modal-titlebar" className="rounded-t-2xl border-b border-bd/10 px-6 py-4 pr-12">
          <h2 className="text-lg font-black tracking-tight">관리자 권한 부여</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm leading-relaxed text-t2">
            <span className="font-bold text-t1">{props.username}</span> ({props.email}) 에게 관리자 권한을 부여할까요?
          </p>
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-t1">
            관리자는 다른 사용자를 잠그거나 비밀번호 재설정 링크를 발급하고, 다른 관리자의 권한을 해제할 수도 있어요. 신뢰할 수 있는 사용자에게만 부여해주세요.
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={props.onCancel}
              disabled={props.busy}
              className="rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2 text-sm font-bold text-t2"
            >취소</button>
            <button
              type="button"
              onClick={props.onConfirm}
              disabled={props.busy}
              className="rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2 text-sm font-black text-white disabled:opacity-60"
            >{props.busy ? "처리 중..." : "권한 부여"}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// AdminResetIssuedModal renders the one-time reset link an admin just
// minted on behalf of another user. The link will never be re-shown,
// so we lean on the AWS IAM / Entra ID pattern: scary copy + a single
// big copy-to-clipboard action. Closing the modal drops the URL from
// component state entirely.
//
// 보안 메모: 이 링크 자체가 새 비밀번호를 설정할 수 있는 권한이기
// 때문에, admin 이 사용자에게 전달하기 전에 화면 캡처/스크린 공유에
// 노출되지 않도록 작은 폰트 + monospace 한 줄로만 표시한다. 굳이
// 마스킹은 하지 않음 — 어차피 admin 의 화면이고, 복사 버튼이
// 일반적인 패턴이라서.
function AdminResetIssuedModal(props: {
  username: string;
  email: string;
  resetURL: string;
  expiresAt: number;
  ttlSec: number;
  onClose: () => void;
}) {
  // copyState 는 세 상태를 구분: 초기/성공/실패. 실패는 보안 컨텍스트가
  // 아니거나(HTTP + 비-localhost) 브라우저 권한이 거절된 경우인데, 둘 다
  // 사용자가 "왜 안 되지?" 가 되지 않도록 명시적 신호가 필요하다. 실패
  // 시엔 input 이 자동 select 되어 있어서 손으로 Ctrl/⌘-C 가 항상 가능.
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEscapeClose(true, props.onClose);

  const minutes = Math.max(1, Math.round(props.ttlSec / 60));
  const expiresAtLabel = new Date(props.expiresAt * 1000).toLocaleString();

  async function copy() {
    // 우선 input 을 selected 상태로 만들어둔다 — execCommand fallback 이
    // 동작하려면 select 가 필수고, 자동 복사가 실패해 사용자가 Ctrl-C
    // 로 직접 복사할 때도 추가 클릭 없이 바로 가능하다.
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }

    // 1차: 표준 Clipboard API. secure context(HTTPS 또는 localhost)
    // 에서만 사용 가능. HTTP + 사설 IP 같이 secure 가 아닌 환경에서는
    // navigator.clipboard 자체가 undefined 라서 try 진입 전 단락된다.
    try {
      if (typeof navigator !== "undefined"
          && navigator.clipboard
          && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(props.resetURL);
        setCopyState("ok");
        setTimeout(() => setCopyState("idle"), 1500);
        return;
      }
    } catch {
      // fall through to fallback
    }

    // 2차: legacy execCommand('copy'). deprecated 지만 비-secure context
    // 에서도 동작해서 우리 운영 환경(사설 IP + HTTP)에 꼭 필요하다. 보안
    // 위험은 본 모달이 admin 본인 화면에 떠 있는 동안만 활성이고,
    // 클립보드에 담기는 값은 이미 admin 에게 공개된 reset URL 이라
    // 추가 노출 risk 가 없다.
    try {
      // input 이 이미 select 됐다고 가정. document.execCommand 는 동기.
      const ok = document.execCommand && document.execCommand("copy");
      if (ok) {
        setCopyState("ok");
        setTimeout(() => setCopyState("idle"), 1500);
        return;
      }
    } catch {
      // fall through
    }

    // 둘 다 실패 — 사용자에게 명시적으로 알리고, input 의 선택 상태는
    // 유지해서 손으로 Ctrl/⌘-C 가능하게 둔다.
    setCopyState("fail");
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div data-role="modal-window" className="relative w-full max-w-md rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
        <ModalCloseButton onClose={props.onClose} />
        <div data-role="modal-titlebar" className="rounded-t-2xl border-b border-bd/10 px-6 py-4 pr-12">
          <h2 className="text-lg font-black tracking-tight">비밀번호 재설정 링크 발급됨</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-t1">
            <p className="font-bold">이 링크는 한 번만 표시돼요.</p>
            <p className="mt-1 text-t2">
              지금 복사해서 안전한 채널(슬랙 DM·대면 전달 등)로
              <span className="font-bold text-t1"> {props.username} </span>
              ({props.email}) 에게 전달해주세요. 모달을 닫으면 다시 볼 수 없고,
              새로 발급해야 해요.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
              재설정 링크 ({minutes}분 후 만료 · {expiresAtLabel})
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                readOnly
                value={props.resetURL}
                className="min-w-0 flex-1 rounded-xl border-2 border-bd/10 bg-s2 px-3 py-2 font-mono text-[11px] text-t1 outline-none"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                onClick={() => void copy()}
                className="rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2 text-sm font-black text-white transition"
              >
                {copyState === "ok" ? "복사됨" : "복사"}
              </button>
            </div>
            {copyState === "fail" ? (
              <p className="mt-2 text-[11px] text-amber-500">
                자동 복사가 실패했어요. 위 입력칸이 선택돼 있으니 Ctrl/⌘-C 로 직접 복사해주세요.
              </p>
            ) : null}
          </div>
          <p className="text-[11px] leading-relaxed text-t3">
            링크를 받은 사용자는 새 비밀번호를 본인이 직접 입력해요. 관리자는
            평문 비밀번호를 알 수 없고, 사용자가 재설정을 완료하는 즉시 해당
            계정의 모든 세션이 종료되고 잠금도 풀려요.
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={props.onClose}
              className="rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2 text-sm font-bold text-t2"
            >닫기</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// WorkspaceCapEditor — inline override input for a single user row.
// Empty = use global default. Setting a positive integer pins that
// user's cap until cleared. Mirrors the admin-row action buttons in
// shape so the row scans as one continuous control surface.
function WorkspaceCapEditor(props: { user: AdminUserRow; onChanged: () => void }) {
  const [draft, setDraft] = useState<string>(
    props.user.workspaceCapOverride != null ? String(props.user.workspaceCapOverride) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = draft.trim();
      let next: number | null;
      if (trimmed === "") {
        next = null;
      } else {
        const n = parseInt(trimmed, 10);
        if (!Number.isFinite(n) || n < 1) {
          setError("1 이상의 정수만 가능해요.");
          setBusy(false);
          return;
        }
        next = n;
      }
      await adminSetWorkspaceCap(props.user.id, next);
      props.onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "set_failed");
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    (draft.trim() === "" && props.user.workspaceCapOverride != null) ||
    (draft.trim() !== "" && parseInt(draft, 10) !== props.user.workspaceCapOverride);

  return (
    <div className="mt-1 flex items-center gap-1.5 pl-1 text-[10px] text-t3">
      <span className="font-bold uppercase tracking-wider">워크스페이스 한도</span>
      <input
        type="number"
        min={1}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="기본값"
        title="비워두면 전역 기본값을 사용해요"
        className="w-14 rounded-md border border-bd/30 bg-s1 px-1.5 py-0.5 text-[10px] text-t1 outline-none disabled:opacity-50"
      />
      {dirty ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-md border border-ac/40 bg-ac/15 px-1.5 py-0.5 text-[10px] font-bold text-ac hover:bg-ac/25 disabled:opacity-50"
        >저장</button>
      ) : null}
      {error ? <span className="text-red-500">{error}</span> : null}
    </div>
  );
}
