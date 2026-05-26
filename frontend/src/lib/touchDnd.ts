import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Touch / pen drag-and-drop layer. HTML5 native D&D ignores touch input on
// every mainstream mobile browser, so this hook reimplements the same flow
// with Pointer Events: long-press to start a drag, finger moves a floating
// ghost, lift the finger and we hit-test elementFromPoint to find the drop
// target. Mouse pointers are deliberately ignored — the desktop code path
// still uses native draggable so we don't double-fire.

export type TouchDragKind = "task" | "section";

export interface TouchDragState {
  // The id being dragged. null when no drag is in progress (or still in the
  // long-press waiting window). Mirrors draggingTaskId / draggingSectionId
  // in App.tsx so the visual "lifting" effect is consistent across input
  // modalities.
  draggingId: string | null;
  kind: TouchDragKind | null;
  // Live finger position in viewport coordinates; null while not dragging.
  // Drives the floating ghost render.
  position: { x: number; y: number } | null;
  // The drop target currently under the finger, resolved via elementFromPoint.
  // Used for highlighting; the actual drop fires the matching onDrop callback.
  hoverTargetId: string | null;
  hoverTargetKind: TouchDragKind | null;
}

interface UseTouchDndOptions {
  // Wired to App.tsx's existing setters so mouse + touch share the same state.
  onTaskDragStart: (taskId: string) => void;
  onTaskDragEnd: () => void;
  onTaskDrop: (sectionId: string) => void;
  onSectionDragStart: (sectionId: string) => void;
  onSectionDragEnd: () => void;
  onSectionDrop: (sectionId: string) => void;
}

const LONG_PRESS_MS = 280;
// Slop radius: if the finger moves more than this before long-press fires,
// treat the gesture as a scroll and abandon the drag attempt. Matches the
// typical native long-press tolerance on Android/iOS.
const MOVE_CANCEL_PX = 8;

export function useTouchDnd(opts: UseTouchDndOptions) {
  const [state, setState] = useState<TouchDragState>({
    draggingId: null,
    kind: null,
    position: null,
    hoverTargetId: null,
    hoverTargetKind: null,
  });

  // Mutable refs for handlers that need the latest options/state without
  // re-binding global listeners on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const longPressTimer = useRef<number | null>(null);
  const pendingDrag = useRef<{
    kind: TouchDragKind;
    id: string;
    startX: number;
    startY: number;
    pointerId: number;
    sourceEl: Element;
  } | null>(null);
  const activeDrag = useRef<{
    kind: TouchDragKind;
    id: string;
    pointerId: number;
    sourceEl: Element;
  } | null>(null);

  // Resolve which drop target sits under the pointer. We look for the nearest
  // element with the right data-role: tasks drop onto kanban-body or
  // kanban-col (both carry a data-section-id), sections drop onto another
  // kanban-col. The floating ghost is briefly hidden during hit-testing so
  // it doesn't catch its own elementFromPoint result in browsers that
  // partially honour pointer-events: none.
  function resolveDropTarget(x: number, y: number, kind: TouchDragKind): { id: string; kind: TouchDragKind } | null {
    const ghosts = Array.from(document.querySelectorAll<HTMLElement>('[data-touch-ghost="1"]'));
    const prev = ghosts.map((g) => g.style.visibility);
    ghosts.forEach((g) => { g.style.visibility = "hidden"; });
    let el: HTMLElement | null = null;
    try {
      el = document.elementFromPoint(x, y) as HTMLElement | null;
    } finally {
      ghosts.forEach((g, i) => { g.style.visibility = prev[i]; });
    }
    if (!el) return null;
    if (kind === "task") {
      const body = el.closest('[data-role="kanban-body"]') as HTMLElement | null;
      if (body?.dataset.sectionId) return { id: body.dataset.sectionId, kind: "task" };
      const col = el.closest('[data-role="kanban-col"]') as HTMLElement | null;
      if (col?.dataset.sectionId) return { id: col.dataset.sectionId, kind: "task" };
      return null;
    }
    // section drag: only land on another column header/body
    const col = el.closest('[data-role="kanban-col"]') as HTMLElement | null;
    if (col?.dataset.sectionId) return { id: col.dataset.sectionId, kind: "section" };
    return null;
  }

  function clearLongPress() {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    pendingDrag.current = null;
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      // Phase 1: waiting on long-press. If the user starts scrolling, bail.
      const pending = pendingDrag.current;
      if (pending && pending.pointerId === e.pointerId) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
          clearLongPress();
        }
        return;
      }
      // Phase 2: actively dragging. Update ghost position + hover target.
      const active = activeDrag.current;
      if (active && active.pointerId === e.pointerId) {
        e.preventDefault();
        const target = resolveDropTarget(e.clientX, e.clientY, active.kind);
        setState({
          draggingId: active.id,
          kind: active.kind,
          position: { x: e.clientX, y: e.clientY },
          hoverTargetId: target?.id ?? null,
          hoverTargetKind: target?.kind ?? null,
        });
      }
    }

    function onUp(e: PointerEvent) {
      // Long-press never fired — nothing to commit, just clean up.
      if (pendingDrag.current && pendingDrag.current.pointerId === e.pointerId) {
        clearLongPress();
        return;
      }
      const active = activeDrag.current;
      if (!active || active.pointerId !== e.pointerId) return;
      const target = resolveDropTarget(e.clientX, e.clientY, active.kind);
      if (target && target.kind === active.kind) {
        if (active.kind === "task") optsRef.current.onTaskDrop(target.id);
        else optsRef.current.onSectionDrop(target.id);
      } else {
        // Dropped outside any valid target — still need to clear the dragging
        // flag in the parent state so the source card stops looking lifted.
        if (active.kind === "task") optsRef.current.onTaskDragEnd();
        else optsRef.current.onSectionDragEnd();
      }
      activeDrag.current = null;
      setState({ draggingId: null, kind: null, position: null, hoverTargetId: null, hoverTargetKind: null });
      // Pointerup triggers a synthetic click on touch — eat the very next
      // click so the card we just dropped doesn't also pop its detail modal.
      const swallow = (ce: Event) => { ce.stopPropagation(); ce.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      // Safety net: if no click fires within a tick, remove the swallower so
      // we don't accidentally eat a legitimate later click.
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
    }

    function onCancel(e: PointerEvent) {
      if (pendingDrag.current?.pointerId === e.pointerId) clearLongPress();
      // Deliberately do NOT tear down an in-flight active drag on cancel.
      // Mobile browsers fire pointercancel for unrelated reasons (an HTML5
      // drag handshake, a swipe-back gesture, the OS dismissing a popup),
      // and treating that as "user gave up" loses the drop. We wait for
      // pointerup or pointerleave-from-window instead.
    }

    // Capture phase + passive=false so we can preventDefault on move and
    // stop the page from scrolling while a drag is live.
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  // Called by a card / column on pointerdown. Mouse pointers are ignored so
  // the desktop HTML5 drag path continues to own that flow.
  function beginPress(kind: TouchDragKind, id: string, e: ReactPointerEvent) {
    if (e.pointerType === "mouse") return;
    // Don't start a drag from interactive controls (buttons, inputs) inside
    // the card — those need to receive the tap normally.
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest("button, input, textarea, select, a, [contenteditable=true]")) return;

    const sourceEl = e.currentTarget as Element;

    clearLongPress();
    pendingDrag.current = {
      kind, id,
      startX: e.clientX, startY: e.clientY,
      pointerId: e.pointerId,
      sourceEl,
    };
    longPressTimer.current = window.setTimeout(() => {
      const pending = pendingDrag.current;
      if (!pending) return;
      pendingDrag.current = null;
      longPressTimer.current = null;
      activeDrag.current = { kind: pending.kind, id: pending.id, pointerId: pending.pointerId, sourceEl: pending.sourceEl };
      // Pin the pointer to the source element so every subsequent
      // pointermove / pointerup is routed back to it regardless of which
      // node sits under the finger. Without this, mobile Safari + some
      // Android browsers stop firing pointermove on the source as soon as
      // the finger leaves it, and our window listener doesn't see them
      // either because the browser has decided the gesture is a scroll.
      try {
        (pending.sourceEl as Element & { setPointerCapture?: (id: number) => void })
          .setPointerCapture?.(pending.pointerId);
      } catch { /* ignore */ }
      if (pending.kind === "task") optsRef.current.onTaskDragStart(pending.id);
      else optsRef.current.onSectionDragStart(pending.id);
      setState({
        draggingId: pending.id,
        kind: pending.kind,
        position: { x: pending.startX, y: pending.startY },
        hoverTargetId: null,
        hoverTargetKind: null,
      });
      // Long-press on mobile defaults to text selection + callout menu. Clear
      // any selection the browser may have already grabbed and blur the
      // active editable so the OS doesn't keep painting selection handles
      // over our ghost while the finger moves.
      try { window.getSelection?.()?.removeAllRanges(); } catch { /* ignore */ }
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) ae.blur();
      // Haptic nudge so the user knows long-press has armed the drag.
      try { navigator.vibrate?.(15); } catch { /* ignore */ }
    }, LONG_PRESS_MS);
  }

  return { state, beginPress };
}
