import { useState, useEffect, useRef, useCallback } from "react";
import { useEscapeClose } from "../lib/escapeStack";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ThemeMode, ThemeState } from "../lib/theme";
import { ConfirmToast } from "./ConfirmToast";
import { SectionIcon } from "./SectionIcons";
import { TaskCard } from "./TaskCard";
import { BookmarkIcon } from "./BookmarkIcon";
import { Card, DangerBtn, EmptyMsg, ExecBadge, FField, FInput, FSelect, SideSection, Tag, Toggle } from "./BoardViewPrimitives";
import {
  MARKER_CATALOG,
  hasMarker,
  toggleMarkerInList,
  type MarkerId,
} from "../lib/markers";
import { useTouchDnd } from "../lib/touchDnd";
import { useBoardPreferences, type ColumnsPerRow } from "../hooks/useBoardPreferences";
import { useBoardShellState } from "../hooks/useBoardShellState";
import { BoardViewOverlays } from "./BoardViewOverlays";
import { BoardLeftSidebar } from "./BoardLeftSidebar";
import { BoardQuickAssignPanel } from "./BoardQuickAssignPanel";
import { BoardTopBar } from "./BoardTopBar";
import { BoardRightSidebar } from "./BoardRightSidebar";

// 아바타 첫 글자 추출. charAt(0)은 surrogate pair(이모지 등)를 반으로 자르기
// 때문에 Array.from으로 코드포인트 단위 첫 글자를 잡는다. 글자가 영문/숫자
// 같은 일반 텍스트면 대문자로 보여주고, 이모지처럼 대문자가 의미 없는 경우
// 원본을 그대로 둔다.
function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? "";
  const upper = first.toUpperCase();
  return upper === first.toLowerCase() ? first : upper;
}

// 첫 1 grapheme 추출. 이모지는 ZWJ(가족·국기)·피부톤 modifier 등으로 여러
// 코드포인트가 한 글자를 이루므로, 가능하면 Intl.Segmenter 로 grapheme 단위로
// 자른다. 미지원 환경은 코드포인트 1개(Array.from)로 폴백한다.
function firstGrapheme(s: string): string {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: "grapheme" });
    for (const { segment } of seg.segment(s)) return segment;
    return "";
  }
  return Array.from(s)[0] ?? "";
}

// 아바타 표시 글리프 결정. 사용자가 지정한 avatar 오버라이드가 있으면 그대로
// 쓰고, 없으면 닉네임 첫 글자, 그것도 없으면 이메일 앞 첫 글자로 폴백한다.
function avatarGlyph(avatar: string, nickname: string, email = ""): string {
  const a = avatar.trim();
  if (a !== "") return a;
  const fromNick = avatarInitial(nickname);
  if (fromNick !== "") return fromNick;
  return avatarInitial(email);
}

// 아바타 입력란/피커에서 추천하는 이모지. macOS 이모지 창처럼 카테고리별로
// 묶되, 의존성 없이 가볍게 유지하려고 자주 쓰는 것만 큐레이션했다.
const AVATAR_EMOJI_GROUPS: Array<{ label: string; emojis: string[] }> = [
  { label: "표정", emojis: ["😀", "😄", "😁", "😊", "🙂", "😉", "😎", "🤓", "🥳", "😇", "🤔", "😴", "🤩", "😍", "🤗", "😺"] },
  { label: "사람·손", emojis: ["👋", "🙌", "👍", "👏", "🙏", "💪", "🫡", "🧑‍💻", "👩‍💻", "👨‍💻", "🧙", "🦸", "🥷", "🧑‍🚀", "🧑‍🎨", "🕵️"] },
  { label: "동물·자연", emojis: ["🐶", "🐱", "🦊", "🐼", "🐨", "🦁", "🐯", "🐸", "🐵", "🦄", "🐙", "🦋", "🌱", "🌳", "🌸", "🍀"] },
  { label: "사물·기호", emojis: ["⭐️", "✨", "🔥", "⚡️", "💡", "🚀", "🎯", "🏆", "🎉", "💎", "🧩", "📌", "📚", "🎨", "🛠️", "❤️"] },
];
import type {
  AgentMember,
  BossReport,
  ChannelBadge,
  NotificationTarget,
  ProviderConfig,
  Section,
  SessionHistoryItem,
  Task,
  Team,
  VaultDocument,
  WebhookConfig,
  WorkspaceSettings,
} from "../lib/types";


// ── Block cursor input ──────────────────────────────────────────────────────

function measureTextPx(text: string, font: string): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function BoardTitleInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [cursorX, setCursorX] = useState(0);
  const [cursorY, setCursorY] = useState(0);
  const [cursorH, setCursorH] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);

  const updateDraft = (v: string) => { setDraft(v); draftRef.current = v; };

  // Sync from parent only when not actively editing
  useEffect(() => { if (!focused) updateDraft(value); }, [value, focused]);

  const commit = useCallback(() => { onChange(draftRef.current); }, [onChange]);
  const cancel = useCallback(() => { updateDraft(value); }, [value]);

  const measureCursor = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? el.value.length;
    const cs = window.getComputedStyle(el);
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const textWidth = measureTextPx(el.value.slice(0, pos), font);
    const fontPx = parseFloat(cs.fontSize);
    const padTop = parseFloat(cs.paddingTop);
    const padBottom = parseFloat(cs.paddingBottom);
    const borderTop = parseFloat(cs.borderTopWidth);
    const borderBottom = parseFloat(cs.borderBottomWidth);
    const contentH = el.offsetHeight - padTop - padBottom - borderTop - borderBottom;
    setCursorX(el.offsetLeft + parseFloat(cs.paddingLeft) + textWidth - el.scrollLeft);
    setCursorY(el.offsetTop + borderTop + padTop + contentH / 2);
    setCursorH(Math.min(fontPx * 0.85, contentH));
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onSel = () => { if (document.activeElement === el) measureCursor(); };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [measureCursor]);

  return (
    <div className="relative w-36 xl:w-56">
      <input
        ref={inputRef}
        data-role="board-title"
        className="w-full min-w-0 rounded-xl bg-transparent px-3 py-1.5 text-sm font-bold ring-0 transition hover:bg-s2 focus:bg-s2 focus:ring-2 focus:ring-ac/25 xl:text-base"
        style={{ WebkitTextFillColor: "rgb(var(--t1))", caretColor: "transparent" } as React.CSSProperties}
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => { setFocused(true); setTimeout(measureCursor, 0); }}
        onBlur={() => { setFocused(false); commit(); }}
        onClick={measureCursor}
        onKeyUp={measureCursor}
        onChange={(e) => { updateDraft(e.target.value); setTimeout(measureCursor, 0); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing)  { e.preventDefault(); inputRef.current?.blur(); }
          if (e.key === "Escape") { e.preventDefault(); cancel(); inputRef.current?.blur(); }
        }}
      />
      {focused && (
        <>
          <span
            className="pointer-events-none absolute rounded-sm bg-ac"
            style={{ left: cursorX, top: cursorY, transform: "translateY(-50%)", width: 7, height: cursorH }}
          />
          <div
            aria-hidden
            data-role="board-title-overlay"
            className="pointer-events-none absolute inset-0 flex items-center px-3 text-sm font-bold xl:text-base"
            style={{
              color: "rgb(var(--ac-fg))",
              WebkitTextFillColor: "rgb(var(--ac-fg))",
              background: "transparent",
              textShadow: "none",
              whiteSpace: "pre",
              clipPath: `inset(${cursorY - cursorH / 2}px calc(100% - ${cursorX + 7}px) calc(100% - ${cursorY + cursorH / 2}px) ${cursorX}px)`,
            }}
          >
            {draft.length > 0 ? draft : placeholder}
          </div>
        </>
      )}
    </div>
  );
}

// ── Confirm toast popup (theme-aware, cute style) ──────────────────────────


export { ConfirmToast } from "./ConfirmToast";

// ── Toy theme mascots: Pac-Man-with-lamp + pig + star ──────────────────────

// 이모지를 OS 네이티브 이모지 입력과 동일하게 컬러로 큼직하게 렌더링하기 위한
// 공통 폰트 스택. 시스템 컬러 이모지 폰트를 우선 적용한다.
const EMOJI_FONT = "\"Apple Color Emoji\",\"Segoe UI Emoji\",\"Noto Color Emoji\",\"Twemoji Mozilla\",sans-serif";

// ────────────────────────────────────────────────────────────────────────────

type BoardViewProps = {
  username: string;
  // 표시용 닉네임 (서버 세션에서 옴, 비어있으면 email local-part 로 채워짐).
  // 상단 바와 모달의 아바타/이름 표시에 사용. 워크스페이스의 displayName 과는
  // 분리된 별도 사용자 속성이다.
  nickname: string;
  // 아바타 오버라이드(보통 이모지 한 글자). 비어있으면 nickname 첫 글자로
  // 폴백한다. 닉네임과 독립적으로 편집된다.
  avatar: string;
  // 닉네임/아바타를 서버에 저장한 후 호출 — App 이 /api/auth/session 을
  // 다시 읽어 새 값으로 세션 상태를 갱신한다.
  onNicknameSaved: () => void;
  // 이메일 인증 / 2FA 상태 (서버의 session 응답에서 옴) — 배너 및 보안 패널 분기에 사용
  emailVerified: boolean;
  totpEnabled: boolean;
  // Phase 6.4 — admin 권한 표시. SecurityPanel 의 admin 섹션 mount 여부.
  isAdmin: boolean;
  // Phase 11 — multi-workspace switcher props. The dropdown lives in
  // the right sidebar header; activating an entry calls onSwitchWorkspace.
  workspaceList: import("../lib/workspaces").WorkspaceListItem[];
  activeWorkspaceID: string;
  workspaceCap: number;
  // 현재 로그인 사용자 ID — 워크스페이스 설정 패널에서 "본인" 행을 구분하는 데 사용.
  selfUserID: string;
  onSwitchWorkspace: (id: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onReloadWorkspaces: () => Promise<void>;
  // 이메일 인증 메일 재발송 핸들러. App 이 toast 도 띄움.
  onResendVerifyEmail: () => void;
  // 2FA 상태가 바뀌면 (활성화/해제) App에게 session 재조회를 요청.
  onSessionInvalidated: () => void;
  // 회원 탈퇴 성공 — App 이 세션 상태를 비우고 로그인 화면으로.
  onAccountDeleted: () => void;
  // 회원 탈퇴 모달의 type-to-confirm 안내 + 검증에 사용. 세션 응답의
  // user.email 을 그대로 흘림 — 서버는 동일한 이메일을 case-insensitive
  // 비교로 한 번 더 검증한다.
  sessionEmail: string;
  boardTitle: string;
  // Increments every time the parent runs resetBoard. BoardView watches
  // it to drop UI-only state (collapsed-column map) that lives outside
  // App's data layer so a reset really does present every column open.
  resetSignal: number;
  sections: Section[];
  tasks: Task[];
  workspaceSettings: WorkspaceSettings;
  teams: Team[];
  teamMembers: AgentMember[];
  bossReports: BossReport[];
  vaultDocs: VaultDocument[];
  providers: ProviderConfig[];
  channels: ChannelBadge[];
  sessions: SessionHistoryItem[];
  query: string;
  title: string;
  description: string;
  assignee: string;
  status: string;
  date: string;
  taskTeamId: string;
  taskAgentId: string;
  newSectionTitle: string;
  newTeamName: string;
  newTeamMission: string;
  newMemberName: string;
  newMemberRole: string;
  newMemberTeamId: string;
  newVaultTitle: string;
  newVaultNote: string;
  vaultSearchQuery: string;
  vaultSearchResults: VaultDocument[];
  vaultSearchLoading: boolean;
  workspaceError: string;
  draggingTaskId: string | null;
  draggingSectionId: string | null;
  spotlightSection: string | null;
  themeState: ThemeState;
  onBoardTitleChange: (value: string) => void;
  onWorkspaceSettingsChange: (value: WorkspaceSettings) => void;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onAssigneeChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onTaskTeamIdChange: (value: string) => void;
  onTaskAgentIdChange: (value: string) => void;
  onNewSectionTitleChange: (value: string) => void;
  onNewTeamNameChange: (value: string) => void;
  onNewTeamMissionChange: (value: string) => void;
  onNewMemberNameChange: (value: string) => void;
  onNewMemberRoleChange: (value: string) => void;
  onNewMemberTeamIdChange: (value: string) => void;
  onNewVaultTitleChange: (value: string) => void;
  onNewVaultNoteChange: (value: string) => void;
  onVaultSearchQueryChange: (value: string) => void;
  onQueryChange: (value: string) => void;
  pendingFiles: File[];
  onPendingFilesChange: (files: File[]) => void;
  imageOutput: boolean;
  onImageOutputChange: (next: boolean) => void;
  imageGridCount: number;
  onImageGridCountChange: (next: number) => void;
  onCreateTask: () => void;
  onCreateWorkflowTask: () => void;
  onCreateSection: () => void;
  onCreateTeam: () => void;
  onRemoveTeam: (teamId: string) => void;
  onAddTeamMember: () => void;
  onRemoveTeamMember: (memberID: string) => void;
  onAddVaultDoc: () => void;
  onRemoveVaultDoc: (docID: string) => void;
  onToggleProvider: (providerID: string) => void;
  onProviderModelChange: (providerID: string, model: string) => void;
  onToggleChannel: (channelID: string) => void;
  onDeleteSection: (sectionID: string) => void;
  onResetBoard: () => void;
  onClearDone: () => void;
  onLogout: () => void;
  onTaskDragStart: (taskId: string) => void;
  onTaskDragEnd: () => void;
  onTaskDrop: (sectionID: string) => void;
  onSectionDragStart: (sectionID: string) => void;
  onSectionDragEnd: () => void;
  onSectionDrop: (sectionID: string) => void;
  onDeleteTask: (taskId: string) => void;
  onUpdateTask: (taskId: string, patch: Partial<Task>) => void;
  onAddAttachment: (taskId: string, file: File) => Promise<void>;
  onRemoveAttachment: (taskId: string, attachmentId: string) => Promise<void>;
  trashedTasks: Task[];
  onRestoreDeletedTask: (taskId: string) => void;
  onPurgeDeletedTask: (taskId: string) => void;
  onStartTask: (taskId: string, status: Task["executionStatus"]) => void;
  onCompleteTask: (taskId: string) => void;
  onApproveReport: (reportId: string) => void;
  onRejectReport: (reportId: string, feedback: string) => void;
  onRestoreTask: (reportId: string) => void;
  // Stage 1-B 지식베이스 등록 토글 (owner-only; ReportCard 자체에서도 한 번 더 게이팅).
  onApproveKBReport: (reportId: string) => void;
  onDemoteKBReport: (reportId: string) => void;
  onResetKBReport: (reportId: string) => void;
  onClearInbox: () => void;
  onReloadWorkspace: () => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onAccentColorChange: (color: string) => void;
  onKitschNameChange: (name: string) => void;
  onKitschTextColorChange: (color: string) => void;
  onToyChassisColorChange: (color: string) => void;
  onBaseColorChange: (color: string) => void;
  onTextColorChange: (color: string) => void;
  webhookConfig: WebhookConfig;
  notifications: NotificationTarget[];
  onUpdateWebhookConfig: (next: Partial<WebhookConfig>) => void;
  onRegenerateWebhookToken: () => void;
  onAddNotification: (name: string, url: string) => void;
  onRemoveNotification: (id: string) => void;
  onToggleNotification: (id: string) => void;
  onUpdateNotification: (id: string, name: string, url: string) => void;
};


const pipelineStages = [
  { key: "inbox",   label: "받은함"  },
  { key: "teams",   label: "팀 배정" },
  { key: "assign",  label: "에이전트" },
  { key: "execute", label: "실행"    },
  { key: "report",  label: "리포트"  },
];

/* ═══════════════════════════════════════════════════
   BoardView root
═══════════════════════════════════════════════════ */
// mostRecentTaskScore returns the latest activity timestamp for a task: the
// deliveredAt of its newest linked report (so completed tasks reflect when
// they finished), falling back to createdAt for tasks that don't yet have a
// report. Used to pick which single task to surface as a collapsed-column
// preview. ISO timestamps sort lexicographically.
function mostRecentTaskScore(task: Task, reports: BossReport[]): string {
  let best = task.createdAt || "";
  for (const r of reports) {
    if (r.taskId === task.id && r.deliveredAt && r.deliveredAt > best) {
      best = r.deliveredAt;
    }
  }
  return best;
}

// 240px is the floor below which a kanban column's header (icon + title
// + count chip + collapse + close) and card content start fighting for
// space; below this we'd rather force a horizontal scroll than squash
// columns into uselessness.
const COLS_CLASS: Record<ColumnsPerRow, string> = {
  auto: "grid-cols-[repeat(auto-fill,minmax(240px,1fr))]",
  "1":  "grid-cols-1",
  "2":  "grid-cols-[repeat(2,minmax(240px,1fr))]",
  "3":  "grid-cols-[repeat(3,minmax(240px,1fr))]",
  "4":  "grid-cols-[repeat(4,minmax(240px,1fr))]",
};

// Mobile-only variants: drop the per-column floor to 160px so two
// columns fit a ~360px phone viewport without horizontal scroll. Card
// chrome already adapts via container queries below ~180px.
const COLS_CLASS_MOBILE: Record<ColumnsPerRow, string> = {
  auto: "grid-cols-[repeat(auto-fill,minmax(160px,1fr))]",
  "1":  "grid-cols-1",
  "2":  "grid-cols-[repeat(2,minmax(160px,1fr))]",
  "3":  "grid-cols-[repeat(3,minmax(160px,1fr))]",
  "4":  "grid-cols-[repeat(4,minmax(160px,1fr))]",
};

// Mobile + mini-card variants: floor drops further to 72px so four
// dense columns fit a ~360px phone even on themes (toy) that wrap the
// board in a chunky outer frame which costs ~20px of horizontal room.
// Header chrome (count chip / collapse btn) gets hidden via container
// queries in styles.css to keep the title + close visible at this width.
const COLS_CLASS_MOBILE_MINI: Record<ColumnsPerRow, string> = {
  auto: "grid-cols-[repeat(auto-fill,minmax(72px,1fr))]",
  "1":  "grid-cols-1",
  "2":  "grid-cols-[repeat(2,minmax(72px,1fr))]",
  "3":  "grid-cols-[repeat(3,minmax(72px,1fr))]",
  "4":  "grid-cols-[repeat(4,minmax(72px,1fr))]",
};

export function BoardView(props: BoardViewProps) {
  const {
    leftTab,
    setLeftTab,
    rightTab,
    setRightTab,
    settingsSubTab,
    setSettingsSubTab,
    assignOpen,
    setAssignOpen,
    inboxFilter,
    setInboxFilter,
    inboxFilterOpen,
    setInboxFilterOpen,
    leftDrawerOpen,
    setLeftDrawerOpen,
    rightDrawerOpen,
    setRightDrawerOpen,
    statusPanelOpen,
    setStatusPanelOpen,
    userInfoOpen,
    setUserInfoOpen,
    clearInboxOpen,
    setClearInboxOpen,
    trashOpen,
    setTrashOpen,
    playgroundOpen,
    setPlaygroundOpen,
    leftDrawerScrollRef,
    rightDrawerScrollRef,
    openRightDrawer,
    toggleLeftDrawer,
    toggleRightDrawer,
    closeDrawers,
  } = useBoardShellState();
  const {
    forceCompact,
    setForceCompact,
    collapsedSections,
    toggleSectionCollapsed,
    markerFilter,
    setMarkerFilter,
    columnsPerRow,
    setColumnsPerRow,
    miniCards,
    setMiniCards,
    isMobileLike,
    boardRef,
    effectiveColumns,
    maxFittingColumns,
  } = useBoardPreferences(props.resetSignal);

  // Touch / pen drag-and-drop. Wires the shared drag callbacks into a
  // long-press-driven Pointer Events flow so the board is usable on mobile;
  // mouse input is left alone and continues to use native HTML5 draggable.
  // Touch devices disable the HTML draggable attribute outright — leaving it
  // on causes the mobile browser to fire pointercancel mid-drag (trying to
  // start a native drag image that never works on touch), which would kill
  // our long-press drag right as it begins.
  const isTouchDevice = typeof window !== "undefined"
    && ("ontouchstart" in window || navigator.maxTouchPoints > 0);
  const touchDnd = useTouchDnd({
    onTaskDragStart: props.onTaskDragStart,
    onTaskDragEnd: props.onTaskDragEnd,
    onTaskDrop: props.onTaskDrop,
    onSectionDragStart: props.onSectionDragStart,
    onSectionDragEnd: props.onSectionDragEnd,
    onSectionDrop: props.onSectionDrop,
  });

  // Header-chip spotlight: clicking a status chip (실행중 / 재요청중 / 대기)
  // briefly highlights every task card with that executionStatus and scrolls
  // the first match into view. Cleared automatically after 1.6s — mirrors
  // spotlightSection, just task-scoped.
  const [spotlightExec, setSpotlightExec] = useState<Task["executionStatus"] | null>(null);
  useEffect(() => {
    if (!spotlightExec) return;
    const timer = window.setTimeout(() => setSpotlightExec(null), 1600);
    return () => window.clearTimeout(timer);
  }, [spotlightExec]);
  function focusExecution(status: Task["executionStatus"]) {
    setSpotlightExec(status);
    // Defer one frame so the data-attr highlight has rendered before scroll.
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-exec-spotlight="${status}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  // Pre-flight confirmation for the "완료 + 보고" button — it bypasses the
  // AI agent and stamps a placeholder summary, so we ask before doing it.
  const [pendingManualClose, setPendingManualClose] = useState<{ id: string; title: string } | null>(null);


  const keyword        = props.query.trim().toLowerCase();
  const unreadCount    = props.bossReports.filter((r) => r.status === "new").length;
  const activeCount    = props.tasks.filter((t) => t.executionStatus === "active").length;
  const retryingCount  = props.tasks.filter((t) => t.executionStatus === "retrying").length;
  const queuedCount    = props.tasks.filter((t) => t.executionStatus === "queued").length;
  const completedCount = props.tasks.filter((t) => t.executionStatus === "completed").length;
  const candidateAgents = props.teamMembers.filter(
    (m) => !props.taskTeamId || m.teamId === props.taskTeamId,
  );

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-base font-sans text-t1"
      data-force-mobile={forceCompact ? "true" : undefined}
    >


      <ConfirmToast
        open={clearInboxOpen}
        title="받은함을 비울까요?"
        message="승인/재요청된 보고서가 모두 사라져요."
        confirmLabel="비우기"
        cancelLabel="취소"
        variant="danger"
        icon={<BearIcon />}
        onConfirm={() => { props.onClearInbox(); setClearInboxOpen(false); }}
        onCancel={() => setClearInboxOpen(false)}
      />

      <ConfirmToast
        open={!!pendingManualClose}
        title="AI 실행 없이 마감할까요?"
        message={pendingManualClose
          ? `"${pendingManualClose.title}" 를 AI 분석 없이 완료 상태로 표시합니다. (이후 "재실행" 으로 AI 분석을 받을 수 있어요)`
          : ""}
        confirmLabel="수동 마감"
        cancelLabel="취소"
        variant="danger"
        icon={<BearIcon />}
        onConfirm={() => {
          if (pendingManualClose) props.onCompleteTask(pendingManualClose.id);
          setPendingManualClose(null);
        }}
        onCancel={() => setPendingManualClose(null)}
      />

      <BoardTopBar
        boardTitle={props.boardTitle}
        rightTab={rightTab}
        leftDrawerOpen={leftDrawerOpen}
        rightDrawerOpen={rightDrawerOpen}
        statusPanelOpen={statusPanelOpen}
        forceCompact={forceCompact}
        unreadCount={unreadCount}
        activeCount={activeCount}
        retryingCount={retryingCount}
        queuedCount={queuedCount}
        nickname={props.nickname}
        avatarLabel={avatarGlyph(props.avatar, props.nickname, props.sessionEmail)}
        emailVerified={props.emailVerified}
        workspaceList={props.workspaceList}
        activeWorkspaceID={props.activeWorkspaceID}
        workspaceCap={props.workspaceCap}
        onReloadWorkspace={props.onReloadWorkspace}
        onBoardTitleChange={props.onBoardTitleChange}
        onToggleLeftDrawer={toggleLeftDrawer}
        onSetLeftTabTeams={() => setLeftTab("teams")}
        onToggleStatusPanel={() => setStatusPanelOpen((value) => !value)}
        onOpenInboxDrawer={() => {
          if (rightDrawerOpen && rightTab === "inbox") {
            setRightDrawerOpen(false);
          } else {
            setRightTab("inbox");
            openRightDrawer();
          }
        }}
        onOpenUserInfo={() => setUserInfoOpen(true)}
        onLogout={props.onLogout}
        onToggleForceCompact={() => setForceCompact((value) => !value)}
        onOpenSettingsDrawer={() => {
          if (!rightDrawerOpen) {
            setRightTab("settings");
            openRightDrawer();
          } else if (rightTab === "settings") {
            setRightDrawerOpen(false);
          } else {
            setRightTab("settings");
          }
        }}
        onSwitchWorkspace={props.onSwitchWorkspace}
        onCreateWorkspace={props.onCreateWorkspace}
        onReloadWorkspaces={props.onReloadWorkspaces}
        onDismissAllDrawers={() => {
          setStatusPanelOpen(false);
          closeDrawers();
        }}
        onFocusExecution={focusExecution}
        onResendVerifyEmail={props.onResendVerifyEmail}
      />

      {/* Error banner */}
      {props.workspaceError ? (
        <div className="flex shrink-0 items-center justify-between border-b border-red-700/40 bg-red-900/20 px-5 py-2">
          <span className="text-sm text-err">{props.workspaceError}</span>
          <button type="button" onClick={props.onReloadWorkspace}
            className="rounded-xl border border-err/30 bg-err/10 px-2.5 py-1 text-xs font-bold text-err transition hover:bg-err/20">
            새로고침
          </button>
        </div>
      ) : null}

      {/* ── 3-column body ── */}
      <div data-role="board-shell" className="relative flex flex-1 overflow-hidden">

        {/* Drawer backdrop (mobile only when either drawer open). Absolute
            inside the board-shell so it always covers exactly the body
            area below the topbar+error-banner stack, regardless of how
            many banners are showing. */}
        {(leftDrawerOpen || rightDrawerOpen) ? (
          <div onClick={() => { setLeftDrawerOpen(false); setRightDrawerOpen(false); }}
            className="absolute inset-0 z-30 bg-black/45 backdrop-blur-sm md:hidden"
            aria-hidden />
        ) : null}

        {/* ─── Left sidebar ─── */}
        <BoardLeftSidebar
          leftDrawerOpen={leftDrawerOpen}
          leftTab={leftTab}
          leftDrawerScrollRef={leftDrawerScrollRef}
          teams={props.teams}
          teamMembers={props.teamMembers}
          newTeamName={props.newTeamName}
          newTeamMission={props.newTeamMission}
          newMemberTeamId={props.newMemberTeamId}
          newMemberName={props.newMemberName}
          newMemberRole={props.newMemberRole}
          onSetLeftTab={setLeftTab}
          onNewTeamNameChange={props.onNewTeamNameChange}
          onNewTeamMissionChange={props.onNewTeamMissionChange}
          onCreateTeam={props.onCreateTeam}
          onRemoveTeam={props.onRemoveTeam}
          onNewMemberTeamIdChange={props.onNewMemberTeamIdChange}
          onNewMemberNameChange={props.onNewMemberNameChange}
          onNewMemberRoleChange={props.onNewMemberRoleChange}
          onAddTeamMember={props.onAddTeamMember}
          onRemoveTeamMember={props.onRemoveTeamMember}
        />

        {/* ─── Center ─── */}
        <div className="flex flex-1 flex-col overflow-hidden">

          {/* Quick Assign drawer */}
          <BoardQuickAssignPanel
            assignOpen={assignOpen}
            title={props.title}
            description={props.description}
            pendingFiles={props.pendingFiles}
            imageOutput={props.imageOutput}
            imageGridCount={props.imageGridCount}
            taskTeamId={props.taskTeamId}
            taskAgentId={props.taskAgentId}
            status={props.status}
            assignee={props.assignee}
            date={props.date}
            providers={props.providers}
            teams={props.teams}
            sections={props.sections}
            candidateAgents={candidateAgents}
            onToggleOpen={() => setAssignOpen((value) => !value)}
            onTitleChange={props.onTitleChange}
            onDescriptionChange={props.onDescriptionChange}
            onPendingFilesChange={props.onPendingFilesChange}
            onImageOutputChange={props.onImageOutputChange}
            onImageGridCountChange={props.onImageGridCountChange}
            onTaskTeamIdChange={props.onTaskTeamIdChange}
            onTaskAgentIdChange={props.onTaskAgentIdChange}
            onStatusChange={props.onStatusChange}
            onAssigneeChange={props.onAssigneeChange}
            onDateChange={props.onDateChange}
            onCreateTask={props.onCreateTask}
            onCreateWorkflowTask={props.onCreateWorkflowTask}
          />

          {/* Board scroll area.
              scrollbar-gutter:stable reserves the 5px scrollbar slot even
              when no scrollbar is rendered, so toggling a filter that
              shrinks content (e.g. bookmark filter) doesn't cause the
              available width to shift by ~5px and reflow the auto-fill
              column grid. Most visible on themes with heavier card
              styling (kitsch) where the page height hovers near the
              scroll threshold. */}
          <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            <div className="p-5 max-md:p-3">

              {/* Board toolbar */}
              <div className="mb-4 flex flex-wrap items-center gap-2.5">
                <div className="relative min-w-40 flex-1">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-t3">
                    <SearchIcon />
                  </span>
                  <input
                    className="w-full rounded-xl border border-bd/10 bg-s2 py-2.5 pl-9 pr-4 text-sm text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
                    value={props.query}
                    onChange={(e) => props.onQueryChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); props.onQueryChange(""); e.currentTarget.blur(); } }}
                    placeholder="태스크 검색..."
                  />
                </div>

                {/* Bookmark filter — toggles a "show only bookmarked tasks"
                    mode across every column. Icon-only by request; the
                    pressed state (filled accent) is the sole label. */}
                <button
                  type="button"
                  data-role="marker-filter"
                  onClick={() => setMarkerFilter((cur) => cur === "bookmark" ? null : "bookmark")}
                  aria-pressed={markerFilter === "bookmark"}
                  aria-label={`${MARKER_CATALOG.bookmark.label}${markerFilter === "bookmark" ? " 필터 해제" : " 필터"}`}
                  title={`${MARKER_CATALOG.bookmark.label}${markerFilter === "bookmark" ? " 필터 해제" : " 필터"}`}
                  className={[
                    "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition",
                    markerFilter === "bookmark"
                      ? "border-ac/40 bg-ac/15 text-ac"
                      : "border-bd/10 bg-s2 text-t2 hover:bg-s3 hover:text-t1",
                  ].join(" ")}
                >
                  <BookmarkIcon active={markerFilter === "bookmark"} size={16} />
                </button>

                <div className="flex items-center gap-2">
                  <FInput value={props.newSectionTitle} onChange={props.onNewSectionTitleChange}
                    placeholder="섹션 이름" compact onSubmit={props.onCreateSection} />
                  <button type="button" onClick={props.onCreateSection}
                    className="whitespace-nowrap rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-xs font-bold text-t2 transition hover:bg-s3 hover:text-t1">
                    + 섹션
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button type="button" onClick={props.onClearDone}
                    className="whitespace-nowrap rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-xs font-bold text-t2 transition hover:bg-s3 hover:text-t1">
                    완료 정리
                  </button>
                  <button type="button" onClick={() => setTrashOpen(true)}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-xs font-bold text-t2 transition hover:bg-s3 hover:text-t1"
                    title="휴지통 (삭제한 태스크 복원)">
                    <TrashIcon />
                    <span>휴지통{props.trashedTasks.length > 0 ? ` ${props.trashedTasks.length}` : ""}</span>
                  </button>
                  <button type="button" onClick={props.onResetBoard}
                    className="whitespace-nowrap rounded-xl border border-err/25 bg-err/8 px-3 py-2 text-xs font-bold text-err transition hover:bg-err/15">
                    보드 초기화
                  </button>
                  <span data-role="status-pill"
                    className="whitespace-nowrap rounded-xl border border-bd/8 bg-s2 px-3 py-2 text-xs text-t3">
                    완료 {completedCount}개
                  </span>
                </div>

                {/* Layout controls row — break onto its own line via
                    a full-width flex-wrap sibling so the columns
                    selector + mini-card toggle don't trail the noisy
                    action cluster (완료 정리 / 휴지통 / 보드 초기화 /
                    완료 N개). Inside this row both controls flow
                    normally and may themselves wrap on very narrow
                    viewports. */}
                <div className="flex w-full flex-wrap items-center gap-2.5">
                  {/* Columns-per-row selector. Numeric options auto-hide
                      based on the live board width — only numbers that
                      can actually fit at the current width show up. The
                      user's saved pick is preserved (state-only clamp at
                      render time), so widening the board reveals options
                      again and the higher number snaps back automatically.
                      Mobile + regular-card mode still caps at 2 because
                      cards become unreadable below ~110px wide. */}
                  <div data-role="segmented-group"
                    className="flex items-center gap-1 rounded-xl border border-bd/10 bg-s2 p-1" title="한 줄에 표시할 칸반 개수">
                    {(["auto", "1", "2", "3", "4"] as ColumnsPerRow[]).map((opt) => {
                      const hideOnMobile = isMobileLike && !miniCards && (opt === "3" || opt === "4");
                      if (hideOnMobile) return null;
                      const numericOpt = Number(opt);
                      const hideByWidth = !isNaN(numericOpt) && numericOpt > maxFittingColumns;
                      if (hideByWidth) return null;
                      return (
                        <button key={opt} type="button"
                          data-role="segmented-btn"
                          data-active={columnsPerRow === opt ? "true" : "false"}
                          onClick={() => setColumnsPerRow(opt)}
                          className={[
                            "min-w-7 rounded-lg px-2 py-1 text-xs font-bold transition",
                            columnsPerRow === opt
                              ? "bg-ac/15 text-ac"
                              : "text-t3 hover:bg-s3 hover:text-t1",
                          ].join(" ")}>
                          {opt === "auto" ? "자동" : opt}
                        </button>
                      );
                    })}
                  </div>

                  {/* Mini-card preview toggle — only meaningful in the
                      mobile-shaped layout. When on, columns 3 / 4 unlock
                      above and each card renders in a stripped-down format
                      so dense layouts stay scannable. */}
                  {isMobileLike ? (
                    <button type="button"
                      onClick={() => setMiniCards((v) => !v)}
                      aria-pressed={miniCards}
                      title={miniCards ? "기본 카드로 보기" : "미니카드 미리보기"}
                      className={[
                        "rounded-xl border px-2.5 py-1 text-[11px] font-bold transition",
                        miniCards
                          ? "border-ac/35 bg-ac/12 text-ac"
                          : "border-bd/10 bg-s2 text-t3 hover:bg-s3 hover:text-t1",
                      ].join(" ")}>
                      미니카드
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Pipeline steps — informational. Stays on one line
                  when the container is wide enough, wraps to two lines
                  when it isn't. Container query (not viewport) so the
                  behavior is correct regardless of theme chrome (toy
                  chassis frame, drawer state, etc.) that shrinks the
                  effective board interior. */}
              <div data-role="pipeline-row" className="mb-5 flex flex-wrap items-center gap-1 pb-1">
                {pipelineStages.map((stage, i) => (
                  <div key={stage.key} className="flex shrink-0 items-center gap-1">
                    <span data-role="pipeline-stage"
                      className="rounded-full border border-bd/8 bg-s2 px-3 py-1 text-[11px] font-semibold text-t3">
                      {stage.label}
                    </span>
                    {i < pipelineStages.length - 1 && (
                      <svg data-role="pipeline-arrow"
                        width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"
                        className="shrink-0 text-t3">
                        <path d="M 3 1.5 L 6.5 5 L 3 8.5" stroke="currentColor" strokeWidth="1.6"
                          strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>

              {/* Kanban columns — user-selectable grid layout.
                  items-start disables row-height equalization so a collapsed
                  or short column doesn't stretch to match the tallest sibling
                  in the same row. Without this, max-height on the body has
                  no visible effect — the column looks "stretched out" because
                  some other column in the row is forcing the height. */}
              <div data-role="kanban-board"
                ref={boardRef}
                data-mini-cards={miniCards && isMobileLike ? "true" : undefined}
                className={`grid items-start gap-3 overflow-x-auto pb-4 md:gap-4 ${(isMobileLike ? (miniCards ? COLS_CLASS_MOBILE_MINI : COLS_CLASS_MOBILE) : COLS_CLASS)[effectiveColumns]}`}>
                {props.sections.length === 0 ? (
                  <div className="flex min-h-64 w-full items-center justify-center rounded-2xl border-2 border-dashed border-bd/10 text-sm text-t3">
                    섹션이 없습니다. 위에서 섹션을 추가해 보세요.
                  </div>
                ) : (
                  props.sections.map((section) => {
                    const sectionTasks = props.tasks.filter((task) => {
                      if (task.status !== section.id) return false;
                      if (markerFilter && !hasMarker(task, markerFilter)) return false;
                      if (!keyword) return true;
                      return [task.title, task.description, task.assignee, task.date]
                        .join(" ").toLowerCase().includes(keyword);
                    });
                    const isCollapsed = !!collapsedSections[section.id];
                    // Collapsed columns surface a single most-recent task as a
                    // preview so the column isn't a blank panel; the user can
                    // still see "the latest thing in here" without expanding.
                    const previewTask = isCollapsed && sectionTasks.length > 0
                      ? sectionTasks.reduce((best, t) =>
                          mostRecentTaskScore(t, props.bossReports) > mostRecentTaskScore(best, props.bossReports) ? t : best)
                      : null;
                    const visibleTasks = isCollapsed
                      ? (previewTask ? [previewTask] : [])
                      : sectionTasks;
                    // Hide the body completely when a collapsed column is also
                    // empty — header alone is the cleanest representation.
                    const showBody = !isCollapsed || visibleTasks.length > 0;
                    return (
                      <section
                        key={section.id}
                        data-role="kanban-col"
                        data-section-id={section.id}
                        draggable={!isTouchDevice}
                        onDragStart={() => props.onSectionDragStart(section.id)}
                        onDragEnd={props.onSectionDragEnd}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => props.onSectionDrop(section.id)}
                        onPointerDown={(e) => touchDnd.beginPress("section", section.id, e)}
                        className={[
                          "flex min-w-0 flex-col rounded-2xl border transition",
                          props.spotlightSection === section.id
                            ? "border-ac/60 shadow-glow-sm"
                            : "border-bd/10 bg-s1",
                          props.draggingSectionId === section.id ? "scale-95 opacity-50" : "",
                          // Highlight the column under the finger during a touch drag
                          touchDnd.state.hoverTargetId === section.id && touchDnd.state.draggingId
                            ? "ring-2 ring-ac/60"
                            : "",
                        ].join(" ")}
                      >
                        <div data-role="kanban-header"
                          className="flex items-center justify-between gap-2 border-b border-bd/8 px-4 py-3">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span data-role="section-icon" className="flex shrink-0 items-center justify-center">
                              <SectionIcon title={section.title} theme={props.themeState.mode} />
                            </span>
                            <h3 className="min-w-0 truncate text-sm font-bold leading-tight text-t1">
                              {section.title}
                            </h3>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <span data-role="section-count"
                              className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-s2 px-1.5 py-0 text-[10px] font-black text-t2">
                              {sectionTasks.length}
                            </span>
                            <button data-role="icon-btn" type="button"
                              onClick={() => toggleSectionCollapsed(section.id)}
                              aria-label={collapsedSections[section.id] ? "펼치기" : "접기"}
                              title={collapsedSections[section.id] ? "펼치기" : "접기"}
                              className="rounded-lg p-1 text-t3 transition hover:bg-s2 hover:text-t1">
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                <path
                                  d={collapsedSections[section.id] ? "M 3 5 L 7 9 L 11 5" : "M 3 9 L 7 5 L 11 9"}
                                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"
                                />
                              </svg>
                            </button>
                            <button data-role="icon-btn" type="button"
                              onClick={() => props.onDeleteSection(section.id)}
                              className="rounded-lg p-1 text-t3 transition hover:bg-err/15 hover:text-err">
                              <CloseIcon />
                            </button>
                          </div>
                        </div>

                        {showBody && (
                        <div
                          data-role="kanban-body"
                          data-section-id={section.id}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => props.onTaskDrop(section.id)}
                          className="flex-1 space-y-2 overflow-y-auto p-3"
                          style={isCollapsed ? undefined : { maxHeight: "min(35vh, 320px)" }}
                        >
                          {sectionTasks.length === 0 ? (
                            <div className="flex h-40 items-center justify-center rounded-xl border-2 border-dashed border-bd/10 text-xs text-t3">
                              {keyword ? "검색 결과 없음" : "여기에 드래그"}
                            </div>
                          ) : (
                            visibleTasks.map((task) => {
                              const team  = props.teams.find((t) => t.id === task.teamId);
                              const agent = props.teamMembers.find((m) => m.id === task.agentId);
                              // Latest report attached to this task (if any), so the kanban card
                              // can open the same fullscreen modal as the inbox card.
                              const taskReports = props.bossReports.filter((r) => r.taskId === task.id);
                              const report = taskReports.length > 0
                                ? taskReports.reduce((a, b) => new Date(a.deliveredAt) > new Date(b.deliveredAt) ? a : b)
                                : undefined;
                              const isSpotlit = spotlightExec === task.executionStatus;
                              return (
                                <TaskCard
                                  key={task.id} task={task} team={team} agent={agent} report={report}
                                  teamAgents={props.teamMembers.filter((m) => m.teamId === task.teamId)}
                                  providers={props.providers}
                                  onProviderModelChange={props.onProviderModelChange}
                                  onToggleProvider={props.onToggleProvider}
                                  isDragging={props.draggingTaskId === task.id}
                                  spotlit={isSpotlit}
                                  nativeDraggable={!isTouchDevice}
                                  onDelete={() => props.onDeleteTask(task.id)}
                                  onUpdate={(patch) => props.onUpdateTask(task.id, patch)}
                                  onAddAttachment={(file) => props.onAddAttachment(task.id, file)}
                                  onRemoveAttachment={(attId) => props.onRemoveAttachment(task.id, attId)}
                                  onDragStart={() => props.onTaskDragStart(task.id)}
                                  onDragEnd={props.onTaskDragEnd}
                                  onTouchDragBegin={(e) => {
                                    // Stop the column-level long-press from also arming itself.
                                    e.stopPropagation();
                                    touchDnd.beginPress("task", task.id, e);
                                  }}
                                  onStart={() => props.onStartTask(task.id, "active")}
                                  onComplete={() => setPendingManualClose({ id: task.id, title: task.title })}
                                />
                              );
                            })
                          )}
                        </div>
                        )}
                      </section>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ─── Right sidebar ─── */}
        <BoardRightSidebar
          rightDrawerOpen={rightDrawerOpen}
          rightDrawerScrollRef={rightDrawerScrollRef}
          rightTab={rightTab}
          settingsSubTab={settingsSubTab}
          unreadCount={unreadCount}
          nickname={props.nickname}
          avatarLabel={avatarGlyph(props.avatar, props.nickname, props.sessionEmail)}
          bossReports={props.bossReports}
          teams={props.teams}
          teamMembers={props.teamMembers}
          tasks={props.tasks}
          inboxFilter={inboxFilter}
          inboxFilterOpen={inboxFilterOpen}
          themeState={props.themeState}
          workspaceSettings={props.workspaceSettings}
          workspaceList={props.workspaceList}
          activeWorkspaceID={props.activeWorkspaceID}
          selfUserID={props.selfUserID}
          totpEnabled={!!props.totpEnabled}
          emailVerified={!!props.emailVerified}
          sessionEmail={props.sessionEmail}
          isAdmin={!!props.isAdmin}
          providers={props.providers}
          channels={props.channels}
          webhookConfig={props.webhookConfig}
          notifications={props.notifications}
          vaultSearchQuery={props.vaultSearchQuery}
          vaultSearchResults={props.vaultSearchResults}
          vaultSearchLoading={props.vaultSearchLoading}
          newVaultTitle={props.newVaultTitle}
          newVaultNote={props.newVaultNote}
          vaultDocs={props.vaultDocs}
          sessions={props.sessions}
          onOpenUserInfo={() => setUserInfoOpen(true)}
          onLogout={props.onLogout}
          onSetRightTab={setRightTab}
          onSetSettingsSubTab={setSettingsSubTab}
          onToggleInboxFilterOpen={() => setInboxFilterOpen((value) => !value)}
          onInboxFilterChange={setInboxFilter}
          onOpenClearInbox={() => setClearInboxOpen(true)}
          onApproveReport={props.onApproveReport}
          onRejectReport={props.onRejectReport}
          onRestoreTask={props.onRestoreTask}
          onStartTask={props.onStartTask}
          onApproveKBReport={props.onApproveKBReport}
          onDemoteKBReport={props.onDemoteKBReport}
          onResetKBReport={props.onResetKBReport}
          onThemeModeChange={props.onThemeModeChange}
          onAccentColorChange={props.onAccentColorChange}
          onKitschNameChange={props.onKitschNameChange}
          onToyChassisColorChange={props.onToyChassisColorChange}
          onBaseColorChange={props.onBaseColorChange}
          onTextColorChange={props.onTextColorChange}
          onWorkspaceSettingsChange={props.onWorkspaceSettingsChange}
          onReloadWorkspaces={props.onReloadWorkspaces}
          onSwitchWorkspace={props.onSwitchWorkspace}
          onResendVerifyEmail={props.onResendVerifyEmail}
          onSessionInvalidated={props.onSessionInvalidated}
          onAccountDeleted={props.onAccountDeleted}
          onToggleProvider={props.onToggleProvider}
          onProviderModelChange={props.onProviderModelChange}
          onOpenPlayground={() => setPlaygroundOpen(true)}
          onToggleChannel={props.onToggleChannel}
          onUpdateWebhookConfig={props.onUpdateWebhookConfig}
          onRegenerateWebhookToken={props.onRegenerateWebhookToken}
          onAddNotification={props.onAddNotification}
          onRemoveNotification={props.onRemoveNotification}
          onToggleNotification={props.onToggleNotification}
          onUpdateNotification={props.onUpdateNotification}
          onVaultSearchQueryChange={props.onVaultSearchQueryChange}
          onNewVaultTitleChange={props.onNewVaultTitleChange}
          onNewVaultNoteChange={props.onNewVaultNoteChange}
          onAddVaultDoc={props.onAddVaultDoc}
          onRemoveVaultDoc={props.onRemoveVaultDoc}
        />
      </div>

      <BoardViewOverlays
        playgroundOpen={playgroundOpen}
        trashOpen={trashOpen}
        userInfoOpen={userInfoOpen}
        username={props.username}
        nickname={props.nickname}
        sessionEmail={props.sessionEmail}
        avatar={props.avatar}
        tasks={props.tasks}
        sections={props.sections}
        trashedTasks={props.trashedTasks}
        touchDragState={touchDnd.state}
        onClosePlayground={() => setPlaygroundOpen(false)}
        onCloseTrash={() => setTrashOpen(false)}
        onCloseUserInfo={() => setUserInfoOpen(false)}
        onRestoreDeletedTask={props.onRestoreDeletedTask}
        onPurgeDeletedTask={props.onPurgeDeletedTask}
        onNicknameSaved={props.onNicknameSaved}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Shared primitives
═══════════════════════════════════════════════════ */

function EmojiAvatarPicker(props: {
  anchor: HTMLElement | null;
  current: string;
  onPick: (emoji: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 직접 붙여넣기 입력은 *uncontrolled* 다. macOS OS 이모지 패널
  // (Ctrl+Cmd+Space)이 이 칸 위에 열려 있을 때, controlled value 로 두면
  // 키 입력마다 React 가 input 을 리렌더 → OS 패널이 커서/조합 상태를 잃고
  // Tab·방향키 내비게이션이 먹통이 된다. ref 로 값을 읽어 그 리렌더를 없앤다.
  const customRef = useRef<HTMLInputElement>(null);
  const [hasCustom, setHasCustom] = useState(false);
  useEscapeClose(true, props.onClose);

  // anchor 의 화면 좌표를 측정해 팝오버 위치를 잡는다. 스크롤/리사이즈 시 갱신.
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useEffect(() => {
    function place() {
      const a = props.anchor;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const width = Math.min(window.innerWidth - 24, 360);
      // 앵커 아래에 띄우되, 오른쪽이 화면을 넘으면 왼쪽으로 당긴다.
      let left = r.left;
      if (left + width > window.innerWidth - 12) left = window.innerWidth - 12 - width;
      if (left < 12) left = 12;
      setPos({ top: r.bottom + 8, left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [props.anchor]);

  // 팝오버(및 앵커) 밖 클릭 시 닫기.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (props.anchor?.contains(t)) return;
      props.onClose();
    };
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
    };
  }, [props]);

  return createPortal(
    <div
      ref={rootRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.min(window.innerWidth - 24, 360) }}
      className="z-[70] rounded-2xl border-2 border-bd/15 bg-s1 p-3 shadow-2xl"
      role="dialog"
      aria-label="이모지 선택"
    >
      <div className="emoji-picker-scroll max-h-[260px] space-y-3 overflow-y-auto pr-1">
        {AVATAR_EMOJI_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-t3">{group.label}</p>
            <div className="grid grid-cols-6 gap-1.5">
              {group.emojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => props.onPick(emoji)}
                  aria-label={emoji}
                  className={[
                    "flex aspect-square items-center justify-center rounded-xl leading-none transition hover:bg-s3",
                    props.current === emoji ? "bg-ac/20 ring-1 ring-ac/50" : "",
                  ].join(" ")}
                  style={{ fontFamily: EMOJI_FONT, fontSize: "26px" }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-bd/10 pt-3">
        <input
          ref={customRef}
          className="min-w-0 flex-1 rounded-lg border border-bd/10 bg-s2 px-2.5 py-1.5 text-base text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
          defaultValue=""
          maxLength={8}
          placeholder="직접 입력"
          // 빈 칸일 때만 일반 폰트로 placeholder 를 그려서 emoji 폰트의 넓은
          // 공백 글리프 때문에 "직접  입력"처럼 벌어져 보이는 걸 막는다.
          // 값이 들어오면 emoji 폰트로 전환해 이모지를 제대로 렌더한다.
          onInput={(e) => {
            // 이모지 1자만 허용. 이모지는 ZWJ/피부톤 등 여러 코드포인트로
            // 이뤄질 수 있어 char length 대신 grapheme 1개로 자른다.
            const el = e.target as HTMLInputElement;
            const one = firstGrapheme(el.value);
            if (el.value !== one) el.value = one;
            setHasCustom(one.trim() !== "");
          }}
          style={{ fontFamily: hasCustom ? EMOJI_FONT : "inherit" }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) props.onPick(v);
            props.onClose();
          }}
        />
        <button
          type="button"
          disabled={!hasCustom}
          onClick={() => {
            const v = customRef.current?.value.trim() ?? "";
            if (v) props.onPick(v);
            props.onClose();
          }}
          className="shrink-0 rounded-lg border border-ac/40 bg-ac/15 px-2.5 py-1.5 text-[11px] font-bold text-ac transition hover:bg-ac/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          적용
        </button>
        <button
          type="button"
          onClick={props.onClear}
          title="이모지 삭제 — 닉네임/이메일 첫 글자로 표시"
          className="shrink-0 rounded-lg border border-err/40 bg-err/10 px-2.5 py-1.5 text-[11px] font-bold text-err transition hover:bg-err/20"
        >
          삭제
        </button>
      </div>
    </div>,
    document.body,
  );
}

function StatusDot(props: { status: string }) {
  const c: Record<string, string> = {
    idle:    "bg-ok",
    busy:    "animate-pulse bg-ac",
    offline: "bg-t3",
  };
  return <span className={`h-2 w-2 shrink-0 rounded-full ${c[props.status] ?? "bg-t3"}`} />;
}

/* ── Icons ─────────────────────────────────────── */

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="inline-block">
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon(props: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
      className={`inline-block transition-transform ${props.open ? "rotate-180" : ""}`}>
      <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  // 14×14 so this lines up with the bookmark badge and the section
  // collapse chevron — all icon-btn children render at the same size and
  // the button padding produces visually identical hit areas.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M 3 3 L 11 11 M 11 3 L 3 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function WarningIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 16;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={["inline-block", props.className ?? ""].join(" ")}>
      <path d="M8 1.5L15 14H1L8 1.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6.5V9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function TrashIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={["inline-block", props.className ?? ""].join(" ")}>
      <path d="M2.5 4.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M4 4.5l.8 8.6a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9L12 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6.7 7.5v3.6M9.3 7.5v3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function ClipIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 12;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={["inline-block", props.className ?? ""].join(" ")}>
      <path d="M11.5 7.5L7.7 11.3a2.5 2.5 0 1 1-3.5-3.5L8.5 3.5a4 4 0 0 1 5.7 5.7l-5.6 5.6"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ReportListIcon — stacked document silhouette used by the report card's
// "관련 보고서" affordance. The back-sheet hints that there's more than one,
// so the icon reads as "history" without an extra label.
export function ReportListIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={["inline-block", props.className ?? ""].join(" ")}>
      <path d="M5 2.5h5l2 2v7.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"
        stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 5.5h3M6 7.5h4M6 9.5h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 4.5v8a1 1 0 0 0 1 1h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 1.5v3M10 15.5v3M3.5 10h-3M19.5 10h-3M5.4 5.4l-2.1-2.1M16.7 16.7l-2.1-2.1M5.4 14.6l-2.1 2.1M16.7 3.3l-2.1 2.1"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// CompactToggleIcon — phone outline when compact mode is on, monitor outline
// when off. Communicates the layout the click would switch *into* is encoded
// by the parent's pressed state; here we just visualize the current mode.
function CompactToggleIcon(props: { active: boolean }) {
  if (props.active) {
    return (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="5" y="1.5" width="8" height="15" rx="1.6" stroke="currentColor" strokeWidth="2.2" />
        <path d="M8 14h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="1.5" y="3" width="15" height="10" rx="1.4" stroke="currentColor" strokeWidth="2.2" />
      <path d="M6 16h6M9 13v3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/* ─────────────────────────────────────────────── */

function BearIcon({ className, size = 84 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 88 100" fill="none" className={className}>
      {/* Soft ground shadow */}
      <ellipse cx="44" cy="96" rx="26" ry="2.5" fill="#000" opacity="0.16" />

      {/* ── Cupcake hat ─────────────────────────── */}
      {/* Stem */}
      <path d="M 44 5 Q 48 1 51 3"
        stroke="#15803d" strokeWidth="2" strokeLinecap="round" fill="none" />
      {/* Cherry */}
      <circle cx="44" cy="8" r="4.2" fill="#ef4444" stroke="#7f1d1d" strokeWidth="2" />
      <ellipse cx="45.6" cy="6.6" rx="1.2" ry="1.6" fill="#fff" opacity="0.65" />
      {/* Pink frosting dome (flat, simple curve) */}
      <path d="M 22 24 Q 22 12 44 12 Q 66 12 66 24 Z"
        fill="#fbcfe8" stroke="#9d174d" strokeWidth="2.5" strokeLinejoin="round" />
      {/* Cream filling stripe */}
      <ellipse cx="44" cy="22" rx="20" ry="1.8" fill="#fff5dc" />
      {/* Hat highlight */}
      <ellipse cx="34" cy="17" rx="4" ry="2" fill="#fff" opacity="0.55" />

      {/* ── Bear silhouette: head + ears as ONE path (flat fill) ── */}
      <path
        d="M 44 38
           C 42 30, 36 22, 26 24
           C 16 26, 14 34, 16 44
           C 8 48, 4 60, 6 76
           C 8 92, 26 100, 44 100
           C 62 100, 80 92, 82 76
           C 84 60, 80 48, 72 44
           C 74 34, 72 26, 62 24
           C 52 22, 46 30, 44 38 Z"
        fill="#a16336" stroke="#3d2510" strokeWidth="2.8" strokeLinejoin="round" />

      {/* Inner ears — flat lighter brown ovals, slightly tilted */}
      <ellipse cx="22" cy="34" rx="4" ry="5"
        transform="rotate(-16 22 34)" fill="#d4a574" />
      <ellipse cx="66" cy="34" rx="4" ry="5"
        transform="rotate(16 66 34)" fill="#d4a574" />

      {/* Muzzle — flat lighter ellipse with outline */}
      <ellipse cx="44" cy="76" rx="14" ry="9"
        fill="#d4a574" stroke="#3d2510" strokeWidth="2" />

      {/* Heart-shaped pink cheeks (flat) */}
      <path d="M 16 64 C 12 60, 12 56, 16 58 C 20 56, 20 60, 16 64 Z"
        fill="#fda4af" />
      <path d="M 72 64 C 68 60, 68 56, 72 58 C 76 56, 76 60, 72 64 Z"
        fill="#fda4af" />

      {/* Sleepy ‿ eyes */}
      <path d="M 28 56 Q 32 61 36 56"
        stroke="#3d2510" strokeWidth="2.8" strokeLinecap="round" fill="none" />
      <path d="M 52 56 Q 56 61 60 56"
        stroke="#3d2510" strokeWidth="2.8" strokeLinecap="round" fill="none" />

      {/* Triangle nose */}
      <path d="M 41 71 L 47 71 L 44 75 Z" fill="#3d2510" />

      {/* ω mouth */}
      <path d="M 44 76 Q 41 79 39.5 78"
        stroke="#3d2510" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M 44 76 Q 47 79 48.5 78"
        stroke="#3d2510" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function SparkleIcon({ className, size = 30 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className}>
      {/* Big chubby sparkle */}
      <path
        d="M 13 3 Q 15.5 12 24.5 14 Q 15.5 16 13 25 Q 10.5 16 1.5 14 Q 10.5 12 13 3 Z"
        fill="currentColor" />
      {/* Inner shine */}
      <ellipse cx="13" cy="10.5" rx="1.4" ry="2.4" fill="white" opacity="0.65" />
      {/* Satellite mini sparkle */}
      <path
        d="M 25 5 Q 26 8 29 9 Q 26 10 25 13 Q 24 10 21 9 Q 24 8 25 5 Z"
        fill="currentColor" opacity="0.85" />
      {/* Tiny dot */}
      <circle cx="27" cy="20" r="1.4" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="inline-block">
      <circle cx="5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1 14c0-2.21 1.79-4 4-4h6c2.21 0 4 1.79 4 4"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="inline-block">
      <rect x="3" y="6" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 6V4a2 2 0 1 1 4 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6" cy="10" r="1" fill="currentColor" />
      <circle cx="10" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

/* ── Utility ──────────────────────────────────── */

