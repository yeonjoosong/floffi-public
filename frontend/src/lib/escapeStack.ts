import { useEffect, useRef } from "react";

// Global ESC stack — every overlay (modal / toast / drawer / popover)
// that closes on Escape should call useEscapeClose(isOpen, onClose).
// Only the topmost open entry fires on a single Escape press, and the
// event is killed so background handlers (the drawer underneath, or
// the modal that launched a child toast) do not also dismiss on the
// same keystroke. Without this, ESC on a drawer + child modal closes
// both at once in the wrong order.
type EscEntry = { id: number; onEscape: () => void };
const escStack: EscEntry[] = [];
let escId = 0;
let escListenerInstalled = false;

function installEscListener() {
  if (escListenerInstalled || typeof window === "undefined") return;
  escListenerInstalled = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const top = escStack[escStack.length - 1];
      if (!top) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      top.onEscape();
    },
    true,
  );
}

export function useEscapeClose(isOpen: boolean, onEscape: () => void) {
  // Hold onEscape in a ref so the callback identity isn't part of
  // the effect deps. Inline arrow callbacks from the caller change
  // every render — without the ref, the effect tears down + re-
  // pushes the stack entry on every render, which is mostly fine
  // but can race against rapid setState bursts and leave the
  // window listener pointing at a stale closure. The ref is
  // updated in render, so the entry's `onEscape` always reaches
  // the latest callback when ESC actually fires.
  const callbackRef = useRef(onEscape);
  callbackRef.current = onEscape;

  useEffect(() => {
    if (!isOpen) return;
    installEscListener();
    const entry: EscEntry = { id: ++escId, onEscape: () => callbackRef.current() };
    escStack.push(entry);
    return () => {
      const idx = escStack.indexOf(entry);
      if (idx !== -1) escStack.splice(idx, 1);
    };
  }, [isOpen]);
}
