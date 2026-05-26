// idleDrafts — best-effort preservation of in-progress user input across an
// idle-triggered logout. Saved right before the redirect to LoginView and
// restored on the next successful authentication.
//
// Scope is intentionally narrow:
//   • quick-assign form (title/description/assignee/date) — these live in
//     App.tsx local state.
//   • task modal — opt-in via a window CustomEvent so the modal can dump
//     its own internal draft state before it unmounts.
//   • playground modal — opt-in via the same CustomEvent. We only persist
//     the prompt textbox; the result history is left in memory.
//
// Anything else (sidebar settings, search query, drawer collapse map) is
// either persisted elsewhere already (workspace state, localStorage) or
// considered cheap to redo by hand.

export const IDLE_DRAFTS_KEY = "floffi:idle-drafts";
export const DRAFTS_FLUSH_EVENT = "floffi:drafts-flush";
export const DRAFTS_RESTORE_EVENT = "floffi:drafts-restore";

export type QuickAssignDraft = {
  title: string;
  description: string;
  assignee: string;
  date: string;
};

export type TaskModalDraft = {
  taskId: string;
  title: string;
  description: string;
  // 옵션 필드 — 모달이 편집 모드에 있을 때만 채워진다.
  // 첨부 파일(File 객체)은 직렬화할 수 없어 의도적으로 제외.
  imageOutput?: boolean;
  imageGridCount?: number;
  agentId?: string;
  savedAt?: number;
};

export type PlaygroundResult = {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  text?: string;
  error?: string;
  latencyMs: number;
  ranAt: string;
};

export type PlaygroundDraft = {
  prompt: string;
  provider?: string;
  model?: string;
  results?: PlaygroundResult[];
};

export type IdleDraftsPayload = {
  savedAt: number;
  quickAssign?: QuickAssignDraft;
  taskModal?: TaskModalDraft;
  playground?: PlaygroundDraft;
};

// Modules can push their drafts into this bucket from a flush handler, and
// the caller in App.tsx reads everything in one shot before writing.
let pendingTaskModal: TaskModalDraft | null = null;
let pendingPlayground: PlaygroundDraft | null = null;

export function setTaskModalDraft(d: TaskModalDraft | null) {
  pendingTaskModal = d;
}

export function setPlaygroundDraft(d: PlaygroundDraft | null) {
  pendingPlayground = d;
}

// captureAndSaveDrafts is the App.tsx entry point fired right before logout.
// It dispatches the flush event (so any open modal can write its bits via
// setTaskModalDraft / setPlaygroundDraft), then snapshots the combined
// payload to localStorage. Skips the write entirely when everything is empty
// so a vanilla idle-logout doesn't litter localStorage.
export function captureAndSaveDrafts(quickAssign: QuickAssignDraft) {
  // Reset pending state before the flush so a stale value from a previous
  // capture doesn't leak into the new one.
  pendingTaskModal = null;
  pendingPlayground = null;

  try {
    window.dispatchEvent(new CustomEvent(DRAFTS_FLUSH_EVENT));
  } catch {
    // ignore — older browsers without CustomEvent constructor (unlikely).
  }

  const hasQuickAssign =
    !!quickAssign.title.trim() ||
    !!quickAssign.description.trim() ||
    !!quickAssign.assignee.trim() ||
    !!quickAssign.date.trim();

  if (!hasQuickAssign && !pendingTaskModal && !pendingPlayground) {
    // Nothing worth saving — and we want to clear any stale draft from a
    // previous session so the next login doesn't restore something the
    // user already finished or threw away.
    try {
      localStorage.removeItem(IDLE_DRAFTS_KEY);
    } catch {
      // ignore
    }
    return;
  }

  const payload: IdleDraftsPayload = {
    savedAt: Date.now(),
  };
  if (hasQuickAssign) payload.quickAssign = quickAssign;
  if (pendingTaskModal) payload.taskModal = pendingTaskModal;
  if (pendingPlayground) payload.playground = pendingPlayground;

  try {
    localStorage.setItem(IDLE_DRAFTS_KEY, JSON.stringify(payload));
  } catch {
    // ignore — quota / private mode
  }
}

export function readDrafts(): IdleDraftsPayload | null {
  // localStorage 가 우선이지만 App.tsx 가 restore 직후 localStorage 를
  // 비우면 그 이후 마운트되는 모달은 fallback 이 작동하지 않는다. 동일
  // 세션 안에서만 유효한 in-memory cache 가 그 빈자리를 메운다.
  try {
    const raw = localStorage.getItem(IDLE_DRAFTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as IdleDraftsPayload;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    // fall through to in-memory cache
  }
  return sessionCache;
}

// sessionCache 는 App.tsx 가 restore 후에도 모달이 fallback 으로 읽을 수
// 있도록 동일 세션 동안 payload 를 메모리에 들고 있는다. 새 로그인 사이클
// (logout → login) 마다 clearSessionCache() 로 정리.
let sessionCache: IdleDraftsPayload | null = null;

export function rememberDraftsInMemory(p: IdleDraftsPayload | null) {
  sessionCache = p;
}

export function clearSessionCache() {
  sessionCache = null;
}

export function clearDrafts() {
  try {
    localStorage.removeItem(IDLE_DRAFTS_KEY);
  } catch {
    // ignore
  }
}
