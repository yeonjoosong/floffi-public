import { useEffect, useRef, useState } from "react";
import { useThemeState } from "./hooks/useThemeState";
import { useAuthPathState } from "./hooks/useAuthPathState";
import { useWorkspaceFlow } from "./hooks/useWorkspaceFlow";
import { useWorkspaceState } from "./hooks/useWorkspaceState";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useReportActions } from "./hooks/useReportActions";
import { useTaskActions } from "./hooks/useTaskActions";
import { BoardView } from "./components/BoardView";
import { AppAuthenticatedOverlays } from "./components/AppAuthenticatedOverlays";
import { AppLoggedOutView } from "./components/AppLoggedOutView";
import { MFAChallengeView } from "./components/MFAChallengeView";
import { ResetPasswordView } from "./components/ResetPasswordView";
import { InviteAcceptView, clearPendingInviteToken } from "./components/InviteAcceptView";
import { startEmailVerify } from "./lib/auth";
import { approveReport as kbApproveReport, demoteReport as kbDemoteReport, resetReportTrust as kbResetReportTrust } from "./lib/reports";
import { UnauthorizedError, deleteAttachment, fetchWorkspace, getWorkspaceETag, hasSection, newId, saveWorkspace, subscribeWorkspaceStream, uploadAttachment } from "./lib/board";
import { LLM_PROVIDERS, clearAllKeys, getKey, type LLMProvider } from "./lib/byok";
import {
  createWorkspace,
  isActiveWorkspaceOwner,
  listWorkspaces,
  renameWorkspace,
  setActiveWorkspaceID as setActiveWorkspaceIDLib,
  setActiveWorkspaceRole as setActiveWorkspaceRoleLib,
  type WorkspaceListItem,
} from "./lib/workspaces";
import {
  captureAndSaveDrafts,
  clearDrafts,
  clearSessionCache,
  readDrafts,
  rememberDraftsInMemory,
  type IdleDraftsPayload,
} from "./lib/idleDrafts";
import {
  LAST_ACTIVITY_KEY,
  LOGIN_AT_KEY,
  startIdleWatcher,
  type IdleLogoutReason,
} from "./lib/idleTimer";
import { findModel, isProviderEnabled } from "./lib/models";
import { DEFAULT_WORKFLOW_STEPS, WORKFLOW_SECTIONS, makeWorkflowAgents } from "./lib/workflow";
import type {
  AgentMember,
  BossReport,
  ChannelBadge,
  NotificationTarget,
  ProviderConfig,
  Section,
  Session,
  SessionHistoryItem,
  Task,
  Team,
  VaultDocument,
  WebhookConfig,
  WorkspaceSettings,
  WorkspaceState,
} from "./lib/types";

const emptyWorkspace: WorkspaceState = {
  boardTitle: "Workspace",
  sections: [],
  tasks: [],
  workspaceSettings: {
    orchestrationMode: "auto",
    promptMode: "task",
    memoryLevel: "L1",
    idleLogoutMinutes: 15,
  },
  teams: [],
  teamMembers: [],
  vaultDocs: [],
  providers: [],
  channels: [],
  sessions: [],
  bossReports: [],
  webhookConfig: { token: "", enabled: false },
  notifications: [],
};

export default function App() {
  // ── Theme ──
  const {
    themeState,
    loadStoredTheme,
    handleThemeModeChange,
    handleAccentColorChange,
    handleKitschNameChange,
    handleKitschTextColorChange,
    handleToyChassisColorChange,
    handleBaseColorChange,
    handleTextColorChange,
  } = useThemeState();

  // 보드 리셋 진행 중 플래그 — 폴링이 구 태스크를 복원하는 race condition 방지
  const isResettingRef = useRef(false);
  // in-flight persistWorkspace 요청 취소용 AbortController
  const persistAbortRef = useRef<AbortController | null>(null);
  // approve/reject 직후 폴링이 구버전 서버 상태로 덮어쓰지 못하도록 차단하는 타임스탬프
  const blockPollUntilRef = useRef(0);
  // 마지막으로 성공 저장한 페이로드(직렬화 문자열). debounce가 내용 변화 없이
  // 재발화할 때 동일한 전체 상태를 또 PUT하는 낭비를 막는다 — 서버는 full-replace
  // 계약이라 변경분만 보낼 수 없으므로, "안 바뀌었으면 아예 안 보낸다"로 처리.
  const lastPersistedRef = useRef<string | null>(null);

  // ── Session ──
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(false);

  // Phase 11 — multi-workspace state. activeWorkspaceID is the one
  // currently displayed in the board; workspaceList is the switcher's
  // input. workspaceCap caps how many a user can have (admin-overridable).
  const [activeWorkspaceID, setActiveWorkspaceIDState] = useState<string>("");
  const [workspaceList, setWorkspaceList] = useState<WorkspaceListItem[]>([]);
  const [workspaceCap, setWorkspaceCap] = useState<number>(3);

  // Login form state. Username field was replaced by email when the new
  // /api/auth/login endpoint shipped; legacy /api/login is still wired
  // server-side as a compat path but the UI only speaks email now.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Which auth screen to show when session is unauthenticated.
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");

  const [sections, setSections] = useState<Section[]>(emptyWorkspace.sections);
  const [tasks, setTasks] = useState<Task[]>(emptyWorkspace.tasks);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>(emptyWorkspace.workspaceSettings);
  const [teams, setTeams] = useState<Team[]>(emptyWorkspace.teams);
  const [teamMembers, setTeamMembers] = useState<AgentMember[]>(emptyWorkspace.teamMembers);
  const [vaultDocs, setVaultDocs] = useState<VaultDocument[]>(emptyWorkspace.vaultDocs);
  const [providers, setProviders] = useState<ProviderConfig[]>(emptyWorkspace.providers);
  const [channels, setChannels] = useState<ChannelBadge[]>(emptyWorkspace.channels);
  const [sessions, setSessions] = useState<SessionHistoryItem[]>(emptyWorkspace.sessions);
  const [bossReports, setBossReports] = useState<BossReport[]>(emptyWorkspace.bossReports);
  const [boardTitle, setBoardTitle] = useState(emptyWorkspace.boardTitle);
  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig>(emptyWorkspace.webhookConfig);
  const [notifications, setNotifications] = useState<NotificationTarget[]>(emptyWorkspace.notifications);

  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [imageOutput, setImageOutput] = useState(false);
  const [imageGridCount, setImageGridCount] = useState(1);
  const [apiKeyMissingOpen, setApiKeyMissingOpen] = useState(false);
  const [freeTierImageBlockedOpen, setFreeTierImageBlockedOpen] = useState(false);
  const [titleMissingOpen, setTitleMissingOpen] = useState(false);
  const [resetBoardConfirmOpen, setResetBoardConfirmOpen] = useState(false);
  // resetSignal — increments each time resetBoard runs. BoardView watches it
  // to clear its local UI state (collapsed-column map) that lives in
  // localStorage / component state outside App's data layer.
  const [resetSignal, setResetSignal] = useState(0);
  const [assignee, setAssignee] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [taskTeamId, setTaskTeamId] = useState("");
  const [taskAgentId, setTaskAgentId] = useState("");
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamMission, setNewTeamMission] = useState("");
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberRole, setNewMemberRole] = useState("");
  const [newMemberTeamId, setNewMemberTeamId] = useState("");
  const [newVaultTitle, setNewVaultTitle] = useState("");
  const [newVaultNote, setNewVaultNote] = useState("");
  const [vaultSearchQuery, setVaultSearchQuery] = useState("");
  const [vaultSearchResults, setVaultSearchResults] = useState<VaultDocument[]>([]);
  const [vaultSearchLoading, setVaultSearchLoading] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [spotlightSection, setSpotlightSection] = useState<string | null>(null);

  // ── Auth Phase 3/4 state ──
  // /verify?token=…, /reset?token=…: routed via window.location.pathname.
  // /verify is a one-shot side-effect — call /complete + toast + reset URL.
  // /reset shows the ResetPasswordView until the user submits.
  // 비밀번호 찾기 모달
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  // Single close helper so the X button, the in-card 닫기 button, and
  // ESC all wipe the same state — closing via ESC should not leave a
  // stale email string queued up for the next open.
  const closeForgot = () => {
    setForgotOpen(false);
    setForgotEmail("");
    setForgotSent(false);
  };
  // 계정 잠금 확인 다이얼로그 — 5회 오답 → tier-1 잠금 시 자동으로 열린다.
  // tier-1 잠금은 시간 기반 자동 해제가 없고 오직 비밀번호 재설정으로만
  // 풀린다. 클릭 한 번으로 forgot-password 모달(이메일 미리 채워짐)로
  // 진입하여 재설정 메일을 받으면 즉시 잠금이 해제된다. tier-2(영구)
  // 잠금은 관리자 개입이 필요하므로 이 다이얼로그를 띄우지 않고 인라인
  // 에러로만 안내. acct-scope rate-limit (잠금 직전 단계)도 같은
  // 다이얼로그를 재사용 — 사용자 입장에서 답은 동일하게 "재설정하라".
  const [lockedDialog, setLockedDialog] = useState<boolean>(false);
  const closeLockedDialog = () => setLockedDialog(false);
  // MFA challenge state — when /api/auth/login responds mfaRequired=true.
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  // Active path-based view: "reset" when ?token=…, "verify-result" after
  // /verify roundtrip, "invite" when /invite?token=… 로 도착, otherwise null.
  const {
    pathView,
    setPathView,
    verifyResult,
    setVerifyResult,
    resetSuccessMessage,
    setResetSuccessMessage,
    accountDeletedMessage,
    setAccountDeletedMessage,
    inviteLoginNotice,
    setInviteLoginNotice,
    describeInviteLoginNotice,
  } = useAuthPathState(!!session?.authenticated);

  useEffect(() => {
    if (pathView?.kind === "invite" && !session?.authenticated) {
      setAuthMode("login");
    }
  }, [pathView, session?.authenticated]);

  // Idle auto-logout — warnSeconds drives the countdown toast.
  // 0 → toast hidden. Drafts-restored toast surfaces a one-shot notice
  // immediately after login when we recovered something from localStorage.
  const [warnSeconds, setWarnSeconds] = useState(0);
  const [draftsRestoredOpen, setDraftsRestoredOpen] = useState(false);
  // Cross-effect signal for "post-logout reason": LoginView shows a small
  // banner-style note ("자동 로그아웃 되었습니다.") so the user understands
  // why they were kicked. Cleared once acknowledged.
  const [autoLogoutReason, setAutoLogoutReason] = useState<IdleLogoutReason | null>(null);
  // Latest workspace settings reachable from inside the idle effect's
  // teardown — needed because the effect captures the initial value at
  // mount and the user may change idleLogoutMinutes during the session.
  // We keep one ref so the closure inside startIdleWatcher's onWarn etc.
  // always reads the freshest copy.
  const draftsStateRef = useRef({ title: "", description: "", assignee: "", date: "" });
  useEffect(() => {
    draftsStateRef.current = { title, description, assignee, date };
  }, [title, description, assignee, date]);

  useEffect(() => {
    void refreshSession();
  }, []);

  useEffect(() => {
    if (!session?.authenticated) {
      setWorkspaceReady(false);
      return;
    }

    void loadWorkspace();
  }, [session?.authenticated]);

  // SSE 구독 — 서버가 변경 즉시 push, 5초 폴링 제거.
  // ETag 비교로 우리 클라이언트가 방금 친 PUT의 메아리는 무시.
  useEffect(() => {
    if (!workspaceReady || !session?.authenticated) return;

    const SERVER_FIELDS = [
      "executionStatus", "workflowStep", "accumulatedContext", "reportId", "status",
    ] as const;

    // forceLogoutOnRevoke runs the standard logout flow with reason=
    // "kicked" so the kicked device lands cleanly on the login screen
    // AND surfaces the auto-logout notice (logout() routes any reason
    // other than "user" into setAutoLogoutReason → ConfirmToast).
    // Wrapped in a check so a stale SSE event after an already-signed-
    // out screen doesn't loop.
    const forceLogoutOnRevoke = () => {
      if (!session?.authenticated) return;
      void logout("kicked");
    };

    const refresh = async () => {
      const pollBlocked = isResettingRef.current || Date.now() < blockPollUntilRef.current;
      if (pollBlocked) return;
      try {
        const next = await fetchWorkspace();
        setTasks(prev => {
          const localMap = new Map(prev.map(t => [t.id, t]));
          return (Array.isArray(next.tasks) ? next.tasks : []).map(serverTask => {
            const local = localMap.get(serverTask.id);
            if (!local) return serverTask; // 새 태스크 (webhook 생성 등)
            const merged = { ...local };
            for (const f of SERVER_FIELDS) merged[f] = serverTask[f] as never;
            return merged;
          });
        });
        setBossReports(Array.isArray(next.bossReports) ? next.bossReports : []);
        setSessions(Array.isArray(next.sessions) ? next.sessions : []);
      } catch (err) {
        // 401 → 다른 디바이스에서 single_session 으로 폐기된 상태.
        // 즉시 로그아웃 흐름으로 빠져서 사용자에게 화면 변화로 알림.
        if (err instanceof UnauthorizedError) {
          forceLogoutOnRevoke();
          return;
        }
        // 그 외 네트워크 일시 실패는 무시 — 다음 SSE 이벤트에서 자연스럽게 회복
      }
    };

    const unsub = subscribeWorkspaceStream(
      (serverETag) => {
        // 우리가 이미 가진 ETag와 같으면 갱신 불필요 (자기가 만든 변경의 echo)
        if (serverETag && serverETag === getWorkspaceETag()) return;
        void refresh();
      },
      // 서버가 heartbeat 시점에 우리 세션이 폐기됐음을 감지하면 이 콜백을 친다.
      forceLogoutOnRevoke,
    );

    // SSE 가 어떤 이유로 끊겨도 단일-세션 kick 감지가 최대 N초 안에는
    // 일어나도록 fallback polling. 15초로 짧게 잡아서 SSE push 가 실패한
    // 환경(프록시 buffering / network blip 등)에서도 사용자 인지 가능 시간 내
    // 로그아웃이 발동한다.
    const fallbackTimer = window.setInterval(() => { void refresh(); }, 15_000);

    return () => {
      unsub();
      window.clearInterval(fallbackTimer);
    };
  }, [workspaceReady, session?.authenticated]);

  useEffect(() => {
    if (!workspaceReady || !session?.authenticated) {
      return;
    }

    const timer = window.setTimeout(() => {
      void persistWorkspace();
    }, 250);

    return () => window.clearTimeout(timer);
  }, [
    boardTitle,
    bossReports,
    channels,
    notifications,
    providers,
    sections,
    session?.authenticated,
    sessions,
    tasks,
    teamMembers,
    teams,
    vaultDocs,
    webhookConfig,
    workspaceReady,
    workspaceSettings,
  ]);

  useEffect(() => {
    if (!spotlightSection) return;
    const timer = window.setTimeout(() => setSpotlightSection(null), 1600);
    return () => window.clearTimeout(timer);
  }, [spotlightSection]);

  useEffect(() => {
    if (!hasSection(sections, status)) {
      setStatus(sections[0]?.id ?? "");
    }
  }, [sections, status]);

  useEffect(() => {
    if (!teams.some((team) => team.id === taskTeamId)) {
      setTaskTeamId(teams[0]?.id ?? "");
    }
  }, [taskTeamId, teams]);

  useEffect(() => {
    const filteredAgents = teamMembers.filter((member) => !taskTeamId || member.teamId === taskTeamId);
    if (!filteredAgents.some((member) => member.id === taskAgentId)) {
      setTaskAgentId(filteredAgents[0]?.id ?? "");
    }
  }, [taskAgentId, taskTeamId, teamMembers]);

  useEffect(() => {
    if (!teams.some((team) => team.id === newMemberTeamId)) {
      setNewMemberTeamId(teams[0]?.id ?? "");
    }
  }, [newMemberTeamId, teams]);

  useEffect(() => {
    if (session?.authenticated && window.location.pathname === "/login") {
      window.history.replaceState({}, "", "/");
    }
  }, [session?.authenticated]);


  // Idle auto-logout watcher. Restarts whenever the user changes the
  // workspace setting (so a switch from "사용 안 함" → "5분" takes effect
  // immediately, not at the next reload). The watcher itself reads
  // loginAt/lastActivityAt from localStorage so cross-tab activity counts.
  useEffect(() => {
    if (!session?.authenticated) return;
    // Seed loginAt right at authentication so the absolute ceiling starts
    // counting from "this login", not from a stale value left behind by a
    // previous user on this machine.
    try {
      if (!localStorage.getItem(LOGIN_AT_KEY)) {
        localStorage.setItem(LOGIN_AT_KEY, String(Date.now()));
      }
    } catch {
      // ignore
    }
    const idleMinutes = workspaceSettings.idleLogoutMinutes ?? 15;
    const teardown = startIdleWatcher({
      config: {
        idleMinutes,
        warningSeconds: 60,
        absoluteHours: 8,
      },
      onWarn: (s) => setWarnSeconds(s),
      onWarnDismiss: () => setWarnSeconds(0),
      onLogout: (reason) => {
        setWarnSeconds(0);
        void logout(reason);
      },
    });
    return teardown;
    // Intentionally NOT depending on `logout`: it's recreated on every
    // render and would cycle the watcher every tick. We capture it via
    // closure; loginAt/lastActivityAt are stored externally so the timing
    // survives the watcher restarts that DO happen (settings change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, workspaceSettings.idleLogoutMinutes]);

  // Restore drafts saved by a prior idle-triggered logout. Runs once per
  // successful authentication; the read clears the localStorage key so
  // subsequent renders don't loop.
  useEffect(() => {
    if (!session?.authenticated || !workspaceReady) return;
    const drafts: IdleDraftsPayload | null = readDrafts();
    if (!drafts) return;
    // Drafts older than 24h are stale (the user probably forgot about them
    // and might be surprised to see them resurface). Drop silently.
    if (Date.now() - drafts.savedAt > 24 * 60 * 60 * 1000) {
      clearDrafts();
      return;
    }
    if (drafts.quickAssign) {
      setTitle(drafts.quickAssign.title ?? "");
      setDescription(drafts.quickAssign.description ?? "");
      setAssignee(drafts.quickAssign.assignee ?? "");
      setDate(drafts.quickAssign.date ?? "");
    }
    // Modals dispatch their own restore via the CustomEvent below; we
    // include the payload so they can self-filter (e.g. taskModal only
    // applies if the same task is reopened). We also stash the payload
    // in an in-memory cache so a modal that mounts AFTER this dispatch
    // (i.e. user opens the modal post-login) can still hydrate via
    // readDrafts() — the localStorage entry is removed right after.
    rememberDraftsInMemory(drafts);
    try {
      window.dispatchEvent(
        new CustomEvent("floffi:drafts-restore", { detail: drafts }),
      );
    } catch {
      // ignore
    }
    setDraftsRestoredOpen(true);
    clearDrafts();
  }, [session?.authenticated, workspaceReady]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runVaultSearch(vaultSearchQuery);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [vaultSearchQuery, session?.authenticated, workspaceReady]);

  function logEvent(title: string, summary: string) {
    const nextEntry: SessionHistoryItem = {
      id: newId(),
      title,
      summary,
      updatedAt: new Date().toISOString(),
    };

    setSessions((current) => [nextEntry, ...current].slice(0, 20));
  }

  const { applyWorkspace, runVaultSearch } = useWorkspaceState({
    authenticated: !!session?.authenticated,
    workspaceReady,
    vaultDocs,
    setBoardTitle,
    setSections,
    setTasks,
    setWorkspaceSettings,
    setTeams,
    setTeamMembers,
    setVaultDocs,
    setProviders,
    setChannels,
    setSessions,
    setBossReports,
    setWebhookConfig,
    setNotifications,
    setStatus,
    setTaskTeamId,
    setNewMemberTeamId,
    setVaultSearchResults,
    setVaultSearchLoading,
  });

  const { persistWorkspace, resetBoard } = useWorkspacePersistence({
    boardTitle,
    sections,
    tasks,
    workspaceSettings,
    teams,
    teamMembers,
    vaultDocs,
    providers,
    channels,
    sessions,
    bossReports,
    webhookConfig,
    notifications,
    isResettingRef,
    persistAbortRef,
    lastPersistedRef,
    setTasks,
    setSections,
    setSessions,
    setBossReports,
    setResetSignal,
    setWorkspaceError,
    applyWorkspace,
  });

  const { refreshSession, loadWorkspace, switchWorkspace } = useWorkspaceFlow({
    activeWorkspaceID,
    workspaceList,
    setSession,
    setSessionLoading,
    setWorkspaceLoading,
    setWorkspaceError,
    setWorkspaceReady,
    setWorkspaceList,
    setWorkspaceCap,
    setActiveWorkspaceIDState,
    loadStoredTheme,
    applyWorkspace,
  });

  async function submitLogin() {
    if (!email.trim() || !password.trim()) {
      setLoginError("이메일과 비밀번호를 모두 입력해주세요.");
      return;
    }

    setLoginLoading(true);
    setLoginError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      if (!response.ok) {
        let errCode = "";
        let lockLevel = 0;
        let rateLimitScope = "";
        try {
          const body = await response.json();
          errCode = body?.error ?? "";
          if (typeof body?.lockLevel === "number") lockLevel = body.lockLevel;
          if (typeof body?.scope === "string") rateLimitScope = body.scope;
        } catch {
          // body wasn't JSON
        }
        if (response.status === 429 || errCode === "rate_limited") {
          // scope=acct (계정 단위 5회 실패) 는 곧 DB 하드 잠금으로 갈 운명.
          // 사용자에게 "그냥 더 시도하지 말고 재설정으로 가세요" 라고 안내하는
          // 게 친절하므로 잠금 다이얼로그와 같은 흐름을 쓴다. scope=ip 는
          // 디바이스/네트워크 단위 버스트(연타·자동화 등)라서 기다리면
          // 풀리는 단순 상황 — 토스트 문구만 노출.
          if (rateLimitScope === "acct") {
            // 모달이 뜨는 케이스는 인라인 에러를 비워둔다 — 같은 메시지가
            // 카드 + 모달 두 군데에 동시 표시되는 시각적 중복을 막기 위함.
            // 모달이 닫힌 뒤에도 인라인은 남기지 않는 게 모달의 "다음 행동
            // 정해졌다" 시그널과 일관됨.
            setLoginError("");
            setLockedDialog(true);
          } else {
            setLoginError("요청이 너무 많아요. 잠시 후 다시 시도해주세요.");
          }
        } else if (errCode === "locked") {
          // 423 Locked. lockLevel=2 means "permanent — admin unlock only";
          // tier-1 잠금은 비밀번호 재설정(이메일 재인증)을 완료해야만
          // 풀린다 — 시간 기반 자동 해제 없음. 사용자에게 한 번에 재설정
          // 흐름으로 보내기 위해 별도 확인 다이얼로그를 띄운다. 다이얼로그
          // 패턴은 토스/카카오뱅크/Apple ID 잠금 화면과 동일 — 인라인
          // 버튼 대신 상태를 한 단계 위로 올려 사용자의 다음 행동을
          // 명확히 한다.
          if (lockLevel === 2) {
            // 영구 잠금은 모달을 띄우지 않으므로 인라인이 유일한 신호.
            setLoginError("계정이 잠금 상태예요. 관리자에게 문의해주세요.");
          } else {
            // tier-1: 모달이 본 메시지를 담당하므로 인라인은 비워둠.
            setLoginError("");
            setLockedDialog(true);
          }
        } else {
          // 실패 횟수는 서버 응답에 포함하지 않는다(사용자 존재 누설 방지).
          // 누적 잠금 정책은 LoginView 의 정적 안내 문구로 사전 고지한다.
          setLoginError("이메일 또는 비밀번호가 올바르지 않아요.");
        }
        return;
      }

      const data = (await response.json()) as Session;
      setInviteLoginNotice("");
      // MFA 1단계: 비밀번호 통과했지만 TOTP 인증이 남았음. 챌린지 토큰을 보관하고
      // 별도 화면으로 전환.
      if (data.mfaRequired && data.challengeToken) {
        setMfaChallenge(data.challengeToken);
        return;
      }
      setSession(data);
      window.history.replaceState({}, "", "/");
    } catch {
      setLoginError("로그인 요청에 실패했어요.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function submitSignup(emailRaw: string, pwd: string, nicknameRaw: string) {
    setLoginLoading(true);
    setLoginError("");
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailRaw,
          password: pwd,
          ...(nicknameRaw ? { nickname: nicknameRaw } : {}),
        }),
      });
      if (!response.ok) {
        let errCode = "";
        try {
          const body = await response.json();
          errCode = body?.error ?? "";
        } catch {
          // ignore
        }
        if (response.status === 429 || errCode === "rate_limited") {
          setLoginError("가입 시도가 너무 많아요. 잠시 후 다시 시도해주세요.");
          return;
        }
        const map: Record<string, string> = {
          email_taken: "이미 등록된 이메일이에요.",
          invalid_email: "이메일 형식이 올바르지 않아요.",
          weak_password: "비밀번호는 최소 10자 이상이어야 해요.",
        };
        setLoginError(map[errCode] ?? "회원가입에 실패했어요.");
        return;
      }
      // 백엔드는 signup 직후 access/refresh 쿠키를 발급한다(기존 테스트가
      // 이 동작을 검증). 하지만 UX 정책상 가입 완료 후에는 자동 로그인
      // 대신 로그인 화면으로 보내기로 했으므로, 응답의 Session은 무시하고
      // 발급된 쿠키를 즉시 무효화한다. await 하지 않으면 다음 마운트에서
      // /api/session이 인증 상태로 응답해 자동 로그인되어 버리므로 여기서는
      // 반드시 await 한다(logout()의 fire-and-forget 패턴과 다른 이유).
      await response.json().catch(() => null);
      await Promise.allSettled([
        fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "signup_complete" }),
        }),
        fetch("/api/logout", { method: "POST", credentials: "include" }),
      ]);
      // 가입 후 로그인 폼은 빈 상태로 시작 — 방금 가입한 이메일을 자동으로
      // 채워두면 "이미 입력한 게 그대로 남았다" 처럼 보이고, 가입과 로그인의
      // 경계가 흐릿해진다. 사용자가 일부러 이메일을 다시 타이핑하면서 "지금부터
      // 로그인 단계" 라는 맥락이 분명해진다(브라우저 자동완성이 있다면 한 번
      // 클릭으로 채워지므로 추가 마찰도 크지 않음).
      setEmail("");
      setPassword("");
      setLoginError("");
      setInviteLoginNotice("");
      setAuthMode("login");
      window.history.replaceState({}, "", "/login");
    } catch {
      setLoginError("회원가입 요청에 실패했어요.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function logout(reason: IdleLogoutReason | "user" = "user") {
    // For idle / absolute logouts, save the user's in-progress drafts so
    // we can restore them on next login. Manual logouts skip this — the
    // user explicitly chose to leave; restoring their half-typed task on
    // someone else's next login would be surprising.
    if (reason === "idle" || reason === "absolute") {
      captureAndSaveDrafts(draftsStateRef.current);
    } else {
      // User-driven logout — wipe any stale draft from a prior idle event.
      clearDrafts();
    }
    // Drop the in-memory restore cache on every logout so the next sign-in
    // can't accidentally pull drafts from a prior session if localStorage
    // is also empty.
    clearSessionCache();

    // Local-state cleanup is done FIRST, before any network call. Reason:
    // earlier we awaited the two logout fetches before flipping the React
    // state, which kept BoardView mounted for ~50-300ms while the requests
    // settled. The auto-logout modal that's supposed to appear together
    // with the login screen lives inside the !authenticated branch, so it
    // didn't actually render until the awaits resolved — users described
    // it as "the modal only shows when I try to log in again." Flipping
    // state first makes the screen transition + modal appear instantly;
    // the fetches still fire below (fire-and-forget) so the server-side
    // session row gets revoked, just without blocking the UI.
    clearAllKeys();
    try {
      localStorage.removeItem(LOGIN_AT_KEY);
      localStorage.removeItem(LAST_ACTIVITY_KEY);
    } catch {
      // ignore
    }
    if (reason === "idle" || reason === "absolute" || reason === "kicked") {
      setAutoLogoutReason(reason);
    } else {
      setAutoLogoutReason(null);
    }
    setWarnSeconds(0);
    setSession({ authenticated: false, username: "" });
    setWorkspaceReady(false);
    // 이전 유저의 워크스페이스 상태(특히 boardTitle)가 다음 유저의
    // loadWorkspace 완료 전까지 화면에 그대로 남는 문제를 막기 위해
    // 모든 워크스페이스 state를 emptyWorkspace 기본값으로 되돌린다.
    setSections(emptyWorkspace.sections);
    setTasks(emptyWorkspace.tasks);
    setWorkspaceSettings(emptyWorkspace.workspaceSettings);
    setTeams(emptyWorkspace.teams);
    setTeamMembers(emptyWorkspace.teamMembers);
    setVaultDocs(emptyWorkspace.vaultDocs);
    setProviders(emptyWorkspace.providers);
    setChannels(emptyWorkspace.channels);
    setSessions(emptyWorkspace.sessions);
    setBossReports(emptyWorkspace.bossReports);
    setBoardTitle(emptyWorkspace.boardTitle);
    setWebhookConfig(emptyWorkspace.webhookConfig);
    setNotifications(emptyWorkspace.notifications);
    setAuthMode("login");
    // Wipe the login form state so the kicked user doesn't land on
    // the login screen with the previous session's email/password
    // (or any prior error toast) still visible. The form is
    // controlled from App, so unmounting LoginView alone wouldn't
    // clear these — they have to be reset explicitly.
    setEmail("");
    setPassword("");
    setLoginError("");
    window.history.replaceState({}, "", "/login");

    // Hit both endpoints during the cutover: /api/auth/logout revokes the
    // new JWT-backed session, /api/logout clears any legacy HMAC cookie
    // that may still be lingering from before the upgrade. Fire-and-
    // forget — we don't need to await for the UI to react.
    void Promise.allSettled([
      fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      }),
      fetch("/api/logout", { method: "POST", credentials: "include" }),
    ]);
  }

  // sectionForAgent picks the kanban column that matches the assigned
  // agent's name — Planner → Planning, Builder → Building, Analyst →
  // Analysis, etc. The 4-character common prefix is the heuristic; floffi
  // ships agent names like "Planner" against section titles like "Planning"
  // so a fixed-length prefix is a clean enough match without parsing roles.
  //
  // Falls back to "Building" (the most common rework column) and then to
  // the section right before Done, so custom layouts (Todo/Doing/Done)
  // still get a sensible destination. Returns undefined if nothing fits
  // (e.g. single-section workspace).
  // Default workflow agentId → sectionId map. The agent name on the workspace
  // can be edited (e.g. Korean rename), but the agentId for the built-in
  // workflow roles is stable, so we resolve by ID first and only fall back to
  // the legacy name-prefix match for user-defined agents.
  const WORKFLOW_AGENT_SECTION: Record<string, string> = {
    planner:    "wf-planning",
    builder:    "wf-building",
    executor:   "wf-executing",
    analyst:    "wf-analysis",
    summarizer: "wf-review",
  };
  function sectionForAgent(agent: AgentMember | undefined): Section | undefined {
    if (agent?.id && WORKFLOW_AGENT_SECTION[agent.id]) {
      const m = sections.find((s) => s.id === WORKFLOW_AGENT_SECTION[agent.id]);
      if (m) return m;
    }
    if (agent?.name && agent.name.length >= 4) {
      const prefix = agent.name.toLowerCase().slice(0, 4);
      const m = sections.find((s) => s.title.toLowerCase().startsWith(prefix));
      if (m) return m;
    }
    const building = sections.find((s) => s.title.toLowerCase() === "building");
    if (building) return building;
    const doneIdx = sections.findIndex((s) => s.title.toLowerCase() === "done");
    if (doneIdx > 0) return sections[doneIdx - 1];
    return undefined;
  }

  // userLabel resolves the honorific the app should use when referring to the
  // user. Priority: workspaceSettings.displayName (LLM 호칭 전용 명시 설정) →
  // session.nickname (사용자 표시 닉네임) → session.username (자동 생성된 handle)
  // → "보스". Used by every place that used to hardcode "보스" (inbox log entries,
  // notifications, …). Server-side prompts still read workspaceSettings.displayName
  // for the LLM honorific override.
  function userLabel(): string {
    const explicit = workspaceSettings.displayName?.trim();
    if (explicit) return explicit;
    const n = session?.nickname?.trim();
    if (n) return n;
    const u = session?.username?.trim();
    if (u) return u;
    return "보스";
  }

  // activeProvider returns the workspace's currently enabled LLM provider as
  // an LLMProvider literal (or undefined if no enabled provider matches a
  // known one). Used to pick the right BYOK key for task-run requests.
  function activeProvider(): LLMProvider | undefined {
    const enabled = providers.find((p) => p.enabled);
    if (!enabled) return undefined;
    const id = enabled.id.toLowerCase();
    if (id === "gemini" || id === "openai" || id === "anthropic") return id;
    return undefined;
  }

  // isFreeTierImageBlocked returns true when a task wants image output but the
  // active provider's selected model is on the free tier. Image generation
  // models (e.g. gemini-2.5-flash-preview-image) have a free-tier quota of 0,
  // so the run would fail server-side with 429. Block early and toast instead.
  function isFreeTierImageBlocked(task: Pick<Task, "imageOutput"> | undefined): boolean {
    if (!task?.imageOutput) return false;
    const provider = providers.find((p) => p.enabled);
    if (!provider) return false;
    const providerId = provider.id.toLowerCase();
    if (providerId !== "gemini" && providerId !== "openai" && providerId !== "anthropic") return false;
    const model = findModel(providerId, provider.model);
    return model?.tier === "free";
  }

  // isMissingKeyError matches the Korean error strings runAgentTask returns
  // when no usable API key is reachable (env var unset and no BYOK key sent).
  // Kept as a permissive substring check so we still catch variants like
  // "Gemini 키가 없습니다" / "OpenAI 키가 없습니다" / "API 키가 설정되지 않았습니다".
  function isMissingKeyError(message: string): boolean {
    return /API 키가 설정되지 않았습니다|키가 없습니다/.test(message);
  }

  // handleAgentError dispatches a run-task error: missing-key errors show the
  // dedicated toast (and never bubble into the workspace-error banner that
  // hides on its own); everything else falls back to the banner so the user
  // still sees real failures (rate limit, network, server error, etc.).
  // Returns true when handled as a missing-key case.
  function handleAgentError(message: string, fallbackPrefix: string): boolean {
    if (isMissingKeyError(message)) {
      setApiKeyMissingOpen(true);
      return true;
    }
    setWorkspaceError(`${fallbackPrefix}: ${message}`);
    return false;
  }

  // hasAnyUsableBYOKKey returns true when at least one enabled provider has a
  // stored BYOK key. Used to pre-warn the user at task-assignment time before
  // any LLM call is attempted. Caveat: this can't see server-side env-var
  // keys, so it's a *hint* — the workflow-creation path still trusts the
  // server's actual response for the hard "block vs allow" decision below.
  function hasAnyUsableBYOKKey(): boolean {
    return LLM_PROVIDERS.some((p) => isProviderEnabled(p) && !!getKey(p));
  }

  function createSection() {
    const trimmedTitle = newSectionTitle.trim();
    if (!trimmedTitle) {
      return;
    }

    const nextSection = {
      id: newId(),
      title: trimmedTitle,
    };

    setSections((current) => [...current, nextSection]);
    setNewSectionTitle("");
    setSpotlightSection(nextSection.id);
    logEvent("Section created", `${trimmedTitle} was added to the mission board.`);
  }

  function createTeam() {
    const name = newTeamName.trim();
    if (!name) return;

    const nextTeam: Team = {
      id: newId(),
      name,
      mission: newTeamMission.trim(),
    };
    setTeams((current) => [...current, nextTeam]);
    setNewTeamName("");
    setNewTeamMission("");
    logEvent("Team created", `${name} is ready to take assignments.`);
  }

  function removeTeam(teamId: string) {
    const removedTeam = teams.find((team) => team.id === teamId);
    setTeams((current) => {
      if (current.length <= 1) {
        return current;
      }

      const remaining = current.filter((team) => team.id !== teamId);
      const fallbackTeamId = remaining[0]?.id ?? "";

      setTeamMembers((currentMembers) =>
        currentMembers.map((member) => (member.teamId === teamId ? { ...member, teamId: fallbackTeamId } : member)),
      );
      setTasks((currentTasks) =>
        currentTasks.map((task) =>
          task.teamId === teamId ? { ...task, teamId: fallbackTeamId, agentId: "" } : task,
        ),
      );
      setBossReports((currentReports) =>
        currentReports.map((report) => (report.teamId === teamId ? { ...report, teamId: fallbackTeamId } : report)),
      );
      return remaining;
    });
    if (removedTeam) {
      logEvent("Team removed", `${removedTeam.name} was removed from the workspace.`);
    }
  }

  function deleteSection(sectionID: string) {
    setSections((current) => {
      if (current.length <= 1) {
        return current;
      }

      const remaining = current.filter((section) => section.id !== sectionID);
      const fallbackSectionID = remaining[0]?.id ?? "";
      setTasks((currentTasks) =>
        currentTasks.map((task) => (task.status === sectionID ? { ...task, status: fallbackSectionID } : task)),
      );
      return remaining;
    });
  }

  function moveTask(nextSectionID: string) {
    if (!draggingTaskId) return;

    setTasks((current) =>
      current.map((task) => (task.id === draggingTaskId ? { ...task, status: nextSectionID } : task)),
    );
    setDraggingTaskId(null);
    setSpotlightSection(nextSectionID);
  }

  function moveSection(targetSectionID: string) {
    if (!draggingSectionId || draggingSectionId === targetSectionID) {
      return;
    }

    setSections((current) => {
      const next = [...current];
      const sourceIndex = next.findIndex((section) => section.id === draggingSectionId);
      const targetIndex = next.findIndex((section) => section.id === targetSectionID);
      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }

      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDraggingSectionId(null);
  }

  function deleteTask(taskId: string) {
    // Soft delete: mark deletedAt so the row survives in the trash UI.
    // The server purges it after trashRetention (7 days). Restoring is
    // just clearing the field.
    const now = new Date().toISOString();
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, deletedAt: now } : task)),
    );
    logEvent("태스크 삭제(휴지통)", `"${tasks.find((t) => t.id === taskId)?.title ?? taskId}" 가 휴지통으로 이동했습니다.`);
  }

  // updateTask applies a partial patch to one task. Used by the task-detail
  // modal's edit mode so the user can fix the prompt / toggle image output
  // before re-running. Persistence flows through the regular workspace save
  // that the next render triggers — no separate endpoint needed.
  function updateTask(taskId: string, patch: Partial<Task>) {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
    );
    const titleHint = patch.title ?? tasks.find((t) => t.id === taskId)?.title ?? taskId;
    logEvent("태스크 수정", `"${titleHint}" 태스크가 수정되었습니다.`);
  }

  // addAttachmentToTask uploads one file against an existing task, then folds
  // the returned TaskAttachment record into local state. Used by the modal's
  // edit mode so users can attach more images without recreating the task.
  async function addAttachmentToTask(taskId: string, file: File) {
    const att = await uploadAttachment(taskId, file);
    setTasks((current) =>
      current.map((t) => (t.id === taskId ? { ...t, attachments: [...(t.attachments ?? []), att] } : t)),
    );
    logEvent("첨부 추가", `"${file.name}" 파일이 첨부되었습니다.`);
  }

  // removeAttachmentFromTask deletes the file on the server first; only on
  // success do we drop it from local state, so a failed delete leaves the
  // attachment visible (and the user can retry).
  async function removeAttachmentFromTask(taskId: string, attachmentId: string) {
    await deleteAttachment(taskId, attachmentId);
    setTasks((current) =>
      current.map((t) => (t.id === taskId ? { ...t, attachments: (t.attachments ?? []).filter((a) => a.id !== attachmentId) } : t)),
    );
    logEvent("첨부 삭제", `첨부 파일이 삭제되었습니다.`);
  }

  function restoreDeletedTask(taskId: string) {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, deletedAt: undefined } : task)),
    );
    logEvent("태스크 복원", `"${tasks.find((t) => t.id === taskId)?.title ?? taskId}" 가 보드로 복원되었습니다.`);
  }

  function purgeDeletedTask(taskId: string) {
    // Hard delete: drop the row entirely. The server's boot-time sweep will
    // remove any leftover attachment files on the next restart.
    setTasks((current) => current.filter((task) => task.id !== taskId));
    logEvent("태스크 영구삭제", `"${tasks.find((t) => t.id === taskId)?.title ?? taskId}" 가 영구 삭제되었습니다.`);
  }

  const { createTask, createWorkflowTask, setTaskExecution } = useTaskActions({
    boardTitle,
    sections,
    tasks,
    workspaceSettings,
    teams,
    teamMembers,
    vaultDocs,
    providers,
    channels,
    sessions,
    bossReports,
    webhookConfig,
    notifications,
    title,
    description,
    pendingFiles,
    imageOutput,
    imageGridCount,
    assignee,
    status,
    date,
    taskTeamId,
    taskAgentId,
    blockPollUntilRef,
    setSections,
    setTasks,
    setTeamMembers,
    setTitle,
    setDescription,
    setAssignee,
    setStatus,
    setDate,
    setQuery,
    setPendingFiles,
    setImageOutput,
    setImageGridCount,
    setSpotlightSection,
    setTitleMissingOpen,
    setApiKeyMissingOpen,
    setFreeTierImageBlockedOpen,
    applyWorkspace,
    activeProvider,
    handleAgentError,
    isFreeTierImageBlocked,
    hasAnyUsableBYOKKey,
    sectionForAgent,
    logEvent,
    userLabel,
  });

  const { completeTask, rejectReport, restoreTask, approveReport } = useReportActions({
    boardTitle,
    sections,
    tasks,
    workspaceSettings,
    teams,
    teamMembers,
    vaultDocs,
    providers,
    channels,
    sessions,
    bossReports,
    webhookConfig,
    notifications,
    blockPollUntilRef,
    persistAbortRef,
    setTasks,
    setTeamMembers,
    setSessions,
    setBossReports,
    spotlightSection,
    setSpotlightSection,
    setWorkspaceError,
    setFreeTierImageBlockedOpen,
    applyWorkspace,
    activeProvider,
    userLabel,
    logEvent,
    handleAgentError,
    sectionForAgent,
    isFreeTierImageBlocked,
  });

  function addTeamMember() {
    const name = newMemberName.trim();
    if (!name) return;
    const teamName = teams.find((team) => team.id === newMemberTeamId)?.name || "a team";

    setTeamMembers((current) => [
      ...current,
      {
        id: newId(),
        name,
        role: newMemberRole.trim(),
        teamId: teams.some((team) => team.id === newMemberTeamId) ? newMemberTeamId : teams[0]?.id ?? "",
        status: "idle",
      },
    ]);
    setNewMemberName("");
    setNewMemberRole("");
    logEvent("Agent added", `${name} joined ${teamName}.`);
  }

  function removeTeamMember(memberID: string) {
    setTeamMembers((current) => current.filter((member) => member.id !== memberID));
    setTasks((current) =>
      current.map((task) => (task.agentId === memberID ? { ...task, agentId: "", assignee: "" } : task)),
    );
    setBossReports((current) =>
      current.map((report) => (report.agentId === memberID ? { ...report, agentId: "" } : report)),
    );
  }

  function addVaultDoc() {
    const nextTitle = newVaultTitle.trim();
    if (!nextTitle) return;

    const nextDoc = {
      id: newId(),
      title: nextTitle,
      note: newVaultNote.trim(),
    };

    setVaultDocs((current) => [...current, nextDoc]);
    setVaultSearchResults((current) => [...current, nextDoc]);
    setNewVaultTitle("");
    setNewVaultNote("");
  }

  function removeVaultDoc(docID: string) {
    setVaultDocs((current) => current.filter((doc) => doc.id !== docID));
    setVaultSearchResults((current) => current.filter((doc) => doc.id !== docID));
  }

  function toggleProvider(providerID: string) {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerID ? { ...provider, enabled: !provider.enabled } : provider,
      ),
    );
  }

  function updateProviderModel(providerID: string, model: string) {
    setProviders((current) =>
      current.map((provider) => (provider.id === providerID ? { ...provider, model } : provider)),
    );
  }

  function updateWebhookConfig(next: Partial<WebhookConfig>) {
    setWebhookConfig((prev) => ({ ...prev, ...next }));
  }

  function regenerateWebhookToken() {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    const token = Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
    setWebhookConfig((prev) => ({ ...prev, token }));
  }

  function addNotification(name: string, url: string) {
    setNotifications((prev) => [
      ...prev,
      { id: newId(), name, url, enabled: true },
    ]);
  }

  function removeNotification(id: string) {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }

  function toggleNotification(id: string) {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, enabled: !n.enabled } : n)),
    );
  }

  function updateNotification(id: string, name: string, url: string) {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, name, url } : n)),
    );
  }

  async function handleBoardTitleChange(next: string) {
    setBoardTitle(next);
    const trimmed = next.trim();
    if (!activeWorkspaceID || !isActiveWorkspaceOwner()) return;
    if (!trimmed) return;
    const current = workspaceList.find((w) => w.id === activeWorkspaceID);
    if (current && current.name === trimmed) return;
    try {
      await renameWorkspace(activeWorkspaceID, trimmed);
      const fresh = await listWorkspaces();
      setWorkspaceList(fresh.workspaces);
      setWorkspaceCap(fresh.cap);
      const updated = fresh.workspaces.find((w) => w.id === activeWorkspaceID);
      if (updated && updated.name !== trimmed && updated.name !== boardTitle) {
        setBoardTitle(updated.name);
      }
    } catch (e) {
      console.warn("[workspace] rename from topbar failed:", e);
    }
  }

  async function handleApproveKB(reportId: string) {
    try {
      await kbApproveReport(reportId);
      const fresh = await fetchWorkspace();
      applyWorkspace(fresh);
    } catch (e) {
      console.warn("[kb] approve failed:", e);
    }
  }

  async function handleDemoteKB(reportId: string) {
    try {
      await kbDemoteReport(reportId);
      const fresh = await fetchWorkspace();
      applyWorkspace(fresh);
    } catch (e) {
      console.warn("[kb] demote failed:", e);
    }
  }

  async function handleResetKB(reportId: string) {
    try {
      await kbResetReportTrust(reportId);
      const fresh = await fetchWorkspace();
      applyWorkspace(fresh);
    } catch (e) {
      console.warn("[kb] reset failed:", e);
    }
  }

  function toggleChannel(channelID: string) {
    setChannels((current) =>
      current.map((channel) =>
        channel.id === channelID
          ? { ...channel, enabled: !channel.enabled, status: channel.enabled ? "Idle" : "Connected" }
          : channel,
      ),
    );
  }

  if (sessionLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-base">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-bd/10 border-t-ac" />
          <p className="text-sm font-semibold text-t3">불러오는 중...</p>
        </div>
      </main>
    );
  }

  // /invite?token=… — 인증된 사용자에게만 즉시 수락 화면을 띄운다.
  // 미인증이면 아래의 일반 LoginView 흐름으로 빠지고, 토큰은
  // sessionStorage 에 보존된 상태에서 로그인 직후 효과(handlePostLoginInvite)
  // 가 복원해 같은 화면으로 돌아온다.
  if (pathView?.kind === "invite" && session?.authenticated) {
    return (
      <InviteAcceptView
        token={pathView.token}
        onAccepted={async (workspaceID) => {
          try {
            const result = await listWorkspaces();
            setWorkspaceList(result.workspaces);
            setWorkspaceCap(result.cap);
            // 중복 수락 재시도/멀티탭 경쟁에서도 서버는 같은 workspaceId 를
            // 성공으로 돌려준다. "새 항목이 생겼는지" 추측하지 말고 그 ID 로
            // 직접 전환해야 이미 멤버였던 성공 케이스도 UI 가 정확하다.
            if (result.workspaces.some((w) => w.id === workspaceID)) {
              void switchWorkspace(workspaceID);
              return;
            }
            const joined = result.workspaces.find(
              (w) => !workspaceList.some((prev) => prev.id === w.id),
            );
            if (joined) void switchWorkspace(joined.id);
          } catch {
            /* listWorkspaces 실패해도 onDismiss 가 메인으로 보낸다 */
          }
        }}
        onDismiss={(inviteErrorCode) => {
          if (inviteErrorCode === "invitation_email_mismatch") {
            const notice = describeInviteLoginNotice(inviteErrorCode);
            setPathView(null);
            window.history.replaceState({}, "", "/login");
            setInviteLoginNotice(notice);
            void logout("user");
            return;
          }
          if (inviteErrorCode === "workspace_cap_reached") {
            setWorkspaceError("워크스페이스 한도에 도달했어요. 기존 워크스페이스를 떠나거나 관리자에게 정원 확장을 요청해주세요.");
          }
          clearPendingInviteToken();
          setPathView(null);
          window.history.replaceState({}, "", "/");
        }}
      />
    );
  }

  // /reset?token=… 라우트는 인증 여부와 무관하게 우선 노출.
  if (pathView?.kind === "reset") {
    return (
      <ResetPasswordView
        token={pathView.token}
        onDone={(ok, msg) => {
          setPathView(null);
          window.history.replaceState({}, "", "/");
          if (ok) {
            // 서버가 모든 refresh 세션을 폐기했으므로 클라이언트 상태도 비워서
            // 새 비밀번호로 다시 로그인하도록 한다.
            setSession({ authenticated: false, username: "" });
            setResetSuccessMessage(msg);
            setAuthMode("login");
          }
        }}
      />
    );
  }

  // MFA 1단계 통과 후 챌린지 토큰 보관 중이면 TOTP/복구 코드 입력 화면.
  if (mfaChallenge) {
    return (
      <MFAChallengeView
        challengeToken={mfaChallenge}
        onDone={(s) => {
          setMfaChallenge(null);
          setSession(s);
          window.history.replaceState({}, "", "/");
        }}
        onCancel={() => { setMfaChallenge(null); }}
      />
    );
  }

  if (!session?.authenticated) {
    return (
      <AppLoggedOutView
        authMode={authMode}
        loginLoading={loginLoading}
        loginError={loginError}
        email={email}
        password={password}
        autoLogoutReason={autoLogoutReason}
        verifyResult={verifyResult}
        resetSuccessMessage={resetSuccessMessage}
        accountDeletedMessage={accountDeletedMessage}
        invitePending={pathView?.kind === "invite"}
        inviteNotice={inviteLoginNotice}
        forgotOpen={forgotOpen}
        forgotEmail={forgotEmail}
        forgotSent={forgotSent}
        lockedDialog={lockedDialog}
        onSubmitLogin={() => { void submitLogin(); }}
        onSubmitSignup={(emailRaw, pwd, nicknameRaw) => { void submitSignup(emailRaw, pwd, nicknameRaw); }}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        onSwitchToLogin={() => {
          setLoginError("");
          setAuthMode("login");
        }}
        onSwitchToSignup={() => {
          setLoginError("");
          setAuthMode("signup");
        }}
        onForgotOpen={() => {
          setForgotEmail(email);
          setForgotSent(false);
          setForgotOpen(true);
        }}
        onAutoLogoutAcknowledge={() => setAutoLogoutReason(null)}
        onClearVerifyResult={() => setVerifyResult(null)}
        onClearResetSuccessMessage={() => setResetSuccessMessage("")}
        onClearAccountDeletedMessage={() => setAccountDeletedMessage("")}
        onForgotEmailChange={setForgotEmail}
        onForgotClose={closeForgot}
        onForgotSent={() => setForgotSent(true)}
        onLockedDialogClose={closeLockedDialog}
        onLockedResetPassword={() => {
          setForgotEmail(email);
          setForgotSent(false);
          setLockedDialog(false);
          setForgotOpen(true);
        }}
      />
    );
  }

  if (workspaceLoading && !workspaceReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-base">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-bd/10 border-t-ac" />
          <p className="text-sm font-semibold text-t3">워크스페이스 불러오는 중...</p>
        </div>
      </main>
    );
  }

  // Split active vs. trashed tasks once at render so every downstream prop
  // (boards, completedCount, search results) sees only live tasks. The
  // trashed list is passed separately for the trash modal.
  const visibleTasks = tasks.filter((t) => !t.deletedAt);
  const trashedTasks = tasks.filter((t) => !!t.deletedAt);

  return (
    <>
    <AppAuthenticatedOverlays
      apiKeyMissingOpen={apiKeyMissingOpen}
      freeTierImageBlockedOpen={freeTierImageBlockedOpen}
      titleMissingOpen={titleMissingOpen}
      resetBoardConfirmOpen={resetBoardConfirmOpen}
      draftsRestoredOpen={draftsRestoredOpen}
      verifyResult={verifyResult}
      warnSeconds={warnSeconds}
      onCloseApiKeyMissing={() => setApiKeyMissingOpen(false)}
      onCloseFreeTierImageBlocked={() => setFreeTierImageBlockedOpen(false)}
      onCloseTitleMissing={() => setTitleMissingOpen(false)}
      onCloseDraftsRestored={() => setDraftsRestoredOpen(false)}
      onCloseVerifyResult={() => setVerifyResult(null)}
      onCancelResetBoard={() => setResetBoardConfirmOpen(false)}
      onConfirmResetBoard={() => {
        setResetBoardConfirmOpen(false);
        void resetBoard();
      }}
      onLogoutNow={(reason) => { void logout(reason); }}
      onWarnSecondsChange={setWarnSeconds}
    />
    <BoardView
      username={session.username || "admin"}
      nickname={session.nickname || session.username || "admin"}
      avatar={session.avatar ?? ""}
      sessionEmail={session.email ?? ""}
      onNicknameSaved={() => { void refreshSession(); }}
      emailVerified={!!session.emailVerified}
      totpEnabled={!!session.totpEnabled}
      isAdmin={!!session.isAdmin}
      onResendVerifyEmail={async () => {
        try {
          await startEmailVerify();
          setVerifyResult({ ok: true, message: "인증 메일을 다시 보냈어요. 메일함을 확인해주세요." });
        } catch {
          setVerifyResult({ ok: false, message: "인증 메일 발송에 실패했어요. 잠시 후 다시 시도해주세요." });
        }
      }}
      onSessionInvalidated={() => { void refreshSession(); }}
      onAccountDeleted={() => {
        // 서버가 이미 쿠키를 클리어했고 DB row 도 삭제된 상태. 클라이언트
        // 측에서는 마지막 정리만 — 입력 폼/세션을 비우고 로그인 화면으로.
        setSession({ authenticated: false, username: "" });
        setEmail("");
        setPassword("");
        setAuthMode("login");
        setAccountDeletedMessage("회원 탈퇴가 완료됐어요. 같은 이메일로 다시 가입할 수 있어요.");
        window.history.replaceState({}, "", "/login");
      }}
      boardTitle={boardTitle}
      resetSignal={resetSignal}
      sections={sections}
      tasks={visibleTasks}
      trashedTasks={trashedTasks}
      onRestoreDeletedTask={restoreDeletedTask}
      onPurgeDeletedTask={purgeDeletedTask}
      workspaceSettings={workspaceSettings}
      teams={teams}
      teamMembers={teamMembers}
      bossReports={bossReports}
      vaultDocs={vaultDocs}
      providers={providers}
      channels={channels}
      sessions={sessions}
      query={query}
      title={title}
      description={description}
      assignee={assignee}
      status={status}
      date={date}
      taskTeamId={taskTeamId}
      taskAgentId={taskAgentId}
      newSectionTitle={newSectionTitle}
      newTeamName={newTeamName}
      newTeamMission={newTeamMission}
      newMemberName={newMemberName}
      newMemberRole={newMemberRole}
      newMemberTeamId={newMemberTeamId}
      newVaultTitle={newVaultTitle}
      newVaultNote={newVaultNote}
      vaultSearchQuery={vaultSearchQuery}
      vaultSearchResults={vaultSearchResults}
      vaultSearchLoading={vaultSearchLoading}
      workspaceError={workspaceError}
      draggingTaskId={draggingTaskId}
      draggingSectionId={draggingSectionId}
      spotlightSection={spotlightSection}
      onBoardTitleChange={handleBoardTitleChange}
      onWorkspaceSettingsChange={setWorkspaceSettings}
      onTitleChange={setTitle}
      onDescriptionChange={setDescription}
      onAssigneeChange={setAssignee}
      onStatusChange={setStatus}
      onDateChange={setDate}
      onTaskTeamIdChange={setTaskTeamId}
      onTaskAgentIdChange={setTaskAgentId}
      onNewSectionTitleChange={setNewSectionTitle}
      onNewTeamNameChange={setNewTeamName}
      onNewTeamMissionChange={setNewTeamMission}
      onNewMemberNameChange={setNewMemberName}
      onNewMemberRoleChange={setNewMemberRole}
      onNewMemberTeamIdChange={setNewMemberTeamId}
      onNewVaultTitleChange={setNewVaultTitle}
      onNewVaultNoteChange={setNewVaultNote}
      onVaultSearchQueryChange={setVaultSearchQuery}
      onQueryChange={setQuery}
      pendingFiles={pendingFiles}
      onPendingFilesChange={setPendingFiles}
      imageOutput={imageOutput}
      onImageOutputChange={setImageOutput}
      imageGridCount={imageGridCount}
      onImageGridCountChange={setImageGridCount}
      onCreateTask={createTask}
      onCreateWorkflowTask={createWorkflowTask}
      onCreateSection={createSection}
      onCreateTeam={createTeam}
      onRemoveTeam={removeTeam}
      onAddTeamMember={addTeamMember}
      onRemoveTeamMember={removeTeamMember}
      onAddVaultDoc={addVaultDoc}
      onRemoveVaultDoc={removeVaultDoc}
      onToggleProvider={toggleProvider}
      onProviderModelChange={updateProviderModel}
      onToggleChannel={toggleChannel}
      webhookConfig={webhookConfig}
      notifications={notifications}
      onUpdateWebhookConfig={updateWebhookConfig}
      onRegenerateWebhookToken={regenerateWebhookToken}
      onAddNotification={addNotification}
      onRemoveNotification={removeNotification}
      onToggleNotification={toggleNotification}
      onUpdateNotification={updateNotification}
      onDeleteSection={deleteSection}
      onResetBoard={() => setResetBoardConfirmOpen(true)}
      onClearDone={() => {
        const doneSection = sections.find((section) => section.title.toLowerCase() === "done");
        if (!doneSection) return;
        setTasks((current) => current.filter((task) => task.status !== doneSection.id));
      }}
      onLogout={() => void logout("user")}
      onTaskDragStart={setDraggingTaskId}
      onTaskDragEnd={() => setDraggingTaskId(null)}
      onTaskDrop={moveTask}
      onSectionDragStart={setDraggingSectionId}
      onSectionDragEnd={() => setDraggingSectionId(null)}
      onSectionDrop={moveSection}
      onDeleteTask={deleteTask}
      onUpdateTask={updateTask}
      onAddAttachment={addAttachmentToTask}
      onRemoveAttachment={removeAttachmentFromTask}
      onStartTask={setTaskExecution}
      onCompleteTask={completeTask}
      onApproveReport={approveReport}
      onRejectReport={rejectReport}
      onRestoreTask={restoreTask}
      onApproveKBReport={handleApproveKB}
      onDemoteKBReport={handleDemoteKB}
      onResetKBReport={handleResetKB}
      onClearInbox={() => {
        const remaining = bossReports.filter((r) => r.status === "new");
        setBossReports(remaining);
        blockPollUntilRef.current = Date.now() + 4000;
        void saveWorkspace({ boardTitle, sections, tasks, workspaceSettings, teams, teamMembers, vaultDocs, providers, channels, sessions, bossReports: remaining, webhookConfig, notifications });
      }}
      onReloadWorkspace={() => void loadWorkspace()}
      themeState={themeState}
      onThemeModeChange={handleThemeModeChange}
      onAccentColorChange={handleAccentColorChange}
      onKitschNameChange={handleKitschNameChange}
      onKitschTextColorChange={handleKitschTextColorChange}
      onToyChassisColorChange={handleToyChassisColorChange}
      onBaseColorChange={handleBaseColorChange}
      onTextColorChange={handleTextColorChange}
      workspaceList={workspaceList}
      activeWorkspaceID={activeWorkspaceID}
      workspaceCap={workspaceCap}
      selfUserID={session?.userId ?? ""}
      onSwitchWorkspace={(id) => void switchWorkspace(id)}
      onCreateWorkspace={async (name) => {
        const result = await createWorkspace(name);
        setWorkspaceList(result.workspaces);
        setWorkspaceCap(result.cap);
        // 새로 만든 워크스페이스 — 목록에 막 추가된 마지막 항목으로 바로 전환.
        const created = result.workspaces[result.workspaces.length - 1];
        if (created) void switchWorkspace(created.id);
      }}
      onReloadWorkspaces={async () => {
        const result = await listWorkspaces();
        setWorkspaceList(result.workspaces);
        setWorkspaceCap(result.cap);
        // 워크스페이스 관리에서 rename 한 경우 SSE 가 결국 새 state 를
        // 가져오지만, 사용자는 즉시 반영을 기대한다. 활성 워크스페이스의
        // 새 이름이 보이는 boardTitle 과 다르면 그 자리에서 동기화한다.
        const active = result.workspaces.find((w) => w.id === activeWorkspaceID);
        if (active && active.name !== boardTitle) {
          setBoardTitle(active.name);
        }
      }}
    />
    </>
  );
}
