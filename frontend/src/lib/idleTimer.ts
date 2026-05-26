// idleTimer — soft / hard / absolute logout watcher for floffi.
//
// Three thresholds, one cross-tab activity stamp:
//
//   • soft idle   : idleMinutes minutes of no activity → warning toast fires
//                   and a 1Hz countdown runs for warningSeconds.
//   • hard logout : countdown reaches 0 → onLogout("idle").
//   • absolute    : loginAt + absoluteHours regardless of activity →
//                   onLogout("absolute"). Always armed, even when
//                   idleMinutes === 0.
//
// Activity in any open tab resets every tab's soft timer via a localStorage
// write + the `storage` event. We deliberately do not sync the warning state
// across tabs — if one tab is mid-countdown and the other tab gets a keypress,
// the activity stamp moves forward and the countdown tab will see the bump
// on its next tick.

export type IdleConfig = {
  idleMinutes: number;      // soft idle threshold; 0 = disabled
  warningSeconds: number;   // countdown before hard logout (default 60)
  absoluteHours: number;    // hard ceiling regardless of activity (default 8)
};

// "kicked" is reused outside the idle watcher — App.tsx's
// forceLogoutOnRevoke path threads it through logout() so the user gets
// the same auto-logout banner treatment when another device under
// single_session=last-wins takes over their session. Kept in this file
// so the union type stays in one place.
export type IdleLogoutReason = "idle" | "absolute" | "kicked";

export const LAST_ACTIVITY_KEY = "floffi:lastActivityAt";
export const LOGIN_AT_KEY = "floffi:loginAt";

// Activity events tracked on the window. visibilitychange is special-cased
// (only counts when the tab becomes visible, not when it hides).
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  "mousemove",
  "mousedown",
  "keydown",
  "click",
  "touchstart",
  "scroll",
  "wheel",
];

// Throttle for stamp writes — without this, mousemove at 60Hz would slam
// localStorage and re-fire storage listeners constantly.
const ACTIVITY_THROTTLE_MS = 1000;

// How recent a keypress must be (and inside an editable element) to suppress
// the warning toast. Lets a user typing a long sentence keep typing without
// being interrupted, while still firing the hard-logout if they truly do go
// idle (typing into a dead-textarea won't keep the watcher alive forever
// because keydown itself is in ACTIVITY_EVENTS and bumps the activity stamp).
const TYPING_GRACE_MS = 5_000;

// writeFreshActivityStamp lets external code (e.g. the toast's "유지하기"
// button) force-reset the timer without dispatching a synthetic DOM event.
export function writeFreshActivityStamp() {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
  } catch {
    // ignore — private mode / quota etc.
  }
}

export function readLoginAt(): number {
  try {
    const v = localStorage.getItem(LOGIN_AT_KEY);
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// startIdleWatcher wires the listeners and timers. Returns a teardown closure;
// calling it removes every listener and stops every interval/timeout.
export function startIdleWatcher(opts: {
  config: IdleConfig;
  onWarn: (secondsLeft: number) => void;
  onWarnDismiss: () => void;
  onLogout: (reason: IdleLogoutReason) => void;
}): () => void {
  const { config, onWarn, onWarnDismiss, onLogout } = opts;
  const idleMs = Math.max(0, Math.floor(config.idleMinutes * 60_000));
  const warnMs = Math.max(1, Math.floor(config.warningSeconds * 1000));
  const absMs = Math.max(1, Math.floor(config.absoluteHours * 3_600_000));

  // Seed login time and activity stamp if they aren't set yet. We want
  // both stamps to exist before the watcher's first tick so the math
  // doesn't underflow to "logged in at epoch 0 → absolute fires now".
  const now = Date.now();
  try {
    if (!localStorage.getItem(LOGIN_AT_KEY)) {
      localStorage.setItem(LOGIN_AT_KEY, String(now));
    }
    if (!localStorage.getItem(LAST_ACTIVITY_KEY)) {
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    }
  } catch {
    // ignore
  }

  let warningActive = false;
  let warningStartedAt = 0;
  let lastKeydownAt = 0;
  let lastActivityWriteAt = 0;
  let loggedOut = false;

  function fireLogout(reason: IdleLogoutReason) {
    if (loggedOut) return;
    loggedOut = true;
    onLogout(reason);
  }

  function bumpActivity() {
    if (loggedOut) return;
    const ts = Date.now();
    // Throttle the localStorage write so a mousemove burst doesn't hammer
    // the disk. The throttle is purely for the stamp write — the warning
    // dismiss path still fires on every tick of the interval below.
    if (ts - lastActivityWriteAt >= ACTIVITY_THROTTLE_MS) {
      lastActivityWriteAt = ts;
      try {
        localStorage.setItem(LAST_ACTIVITY_KEY, String(ts));
      } catch {
        // ignore
      }
    }
    if (warningActive) {
      warningActive = false;
      onWarnDismiss();
    }
  }

  function handleKeydown(_e: KeyboardEvent) {
    lastKeydownAt = Date.now();
    // Bump activity for keydown like every other event. The timestamp
    // above doubles as the "is the user typing right now?" gate for the
    // editable-element warning suppression below.
    bumpActivity();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      bumpActivity();
    }
  }

  function readLastActivity(): number {
    try {
      const v = localStorage.getItem(LAST_ACTIVITY_KEY);
      if (!v) return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  function isTypingInEditable(): boolean {
    if (Date.now() - lastKeydownAt > TYPING_GRACE_MS) return false;
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return true;
    if (el.getAttribute("contenteditable") === "true") return true;
    return false;
  }

  // Periodic tick — every second by default. Keeps the warning countdown
  // accurate and watches for both the soft and absolute thresholds.
  function tick() {
    if (loggedOut) return;
    const ts = Date.now();
    const loginAt = readLoginAt();
    const lastAct = readLastActivity();

    // Absolute ceiling: always armed, regardless of idleMinutes.
    if (loginAt > 0 && ts - loginAt >= absMs) {
      fireLogout("absolute");
      return;
    }

    // Soft idle disabled — only absolute is active.
    if (idleMs === 0) {
      return;
    }

    // No activity stamp yet (first tick after a wipe). Treat as fresh
    // activity so we don't trip the warning immediately.
    if (lastAct === 0) {
      try {
        localStorage.setItem(LAST_ACTIVITY_KEY, String(ts));
      } catch {
        // ignore
      }
      return;
    }

    const sinceActivity = ts - lastAct;

    if (!warningActive) {
      if (sinceActivity >= idleMs) {
        // Suppress the warning ONLY if the user is mid-sentence in an
        // editable element. The hard-logout path still proceeds — typing
        // alone wouldn't, but bumpActivity does fire on keydown so a real
        // typer never reaches this branch.
        if (isTypingInEditable()) {
          return;
        }
        warningActive = true;
        warningStartedAt = ts;
        onWarn(Math.ceil(warnMs / 1000));
      }
      return;
    }

    // Warning is active — count down toward hard logout.
    const elapsed = ts - warningStartedAt;
    const remaining = warnMs - elapsed;
    if (remaining <= 0) {
      fireLogout("idle");
      return;
    }
    onWarn(Math.ceil(remaining / 1000));
  }

  // Wire activity listeners. Using `passive: true` everywhere so the timer
  // can't pin the main thread on touch/scroll devices.
  const listenerOpts: AddEventListenerOptions = { passive: true, capture: true };
  for (const evt of ACTIVITY_EVENTS) {
    if (evt === "keydown") {
      window.addEventListener(evt, handleKeydown as EventListener, listenerOpts);
    } else {
      window.addEventListener(evt, bumpActivity, listenerOpts);
    }
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);

  // Cross-tab sync — when another tab writes a fresh stamp, dismiss the
  // warning in this tab. The tick() will pick up the new stamp on its next
  // run regardless, but firing onWarnDismiss synchronously here gives the
  // UI a snappier feel.
  function handleStorage(e: StorageEvent) {
    if (e.key !== LAST_ACTIVITY_KEY) return;
    if (warningActive) {
      warningActive = false;
      onWarnDismiss();
    }
  }
  window.addEventListener("storage", handleStorage);

  const tickId = window.setInterval(tick, 1000);

  // Run an immediate tick so the absolute-ceiling check fires without
  // waiting one second after mount. Tests rely on this for predictable
  // behavior; users won't notice the difference.
  tick();

  return function teardown() {
    for (const evt of ACTIVITY_EVENTS) {
      if (evt === "keydown") {
        window.removeEventListener(evt, handleKeydown as EventListener, listenerOpts);
      } else {
        window.removeEventListener(evt, bumpActivity, listenerOpts);
      }
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("storage", handleStorage);
    window.clearInterval(tickId);
  };
}
