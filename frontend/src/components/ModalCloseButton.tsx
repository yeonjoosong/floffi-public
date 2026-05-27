// ModalCloseButton — the small × pinned to a modal's top-right corner.
//
// Rendered as <span role="button"> to side-step the theme-wide
// `button { ... !important }` rules in styles.css (candy/toy/kitsch)
// that paint every <button> as a pill — those would turn the close
// X into a giant gradient-filled circle. See PasswordInput.tsx for
// the same trick on the password reveal toggle.
//
// Position is `absolute right-3 top-3`, so the host modal needs a
// `relative` ancestor (every modal card already does — they all have
// border / bg / padding wrappers).
//
// Usage:
//   <ModalCloseButton onClose={onClose} />
//
// Or with a custom positioning (rarely needed):
//   <ModalCloseButton onClose={onClose} className="right-4 top-4" />

type Props = {
  onClose: () => void;
  // Override the default `absolute right-3 top-3` position when the
  // host card has its own header chrome that crowds the corner.
  className?: string;
  // Accessible label override — defaults to "닫기".
  ariaLabel?: string;
};

export function ModalCloseButton(props: Props) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClose();
        }
      }}
      aria-label={props.ariaLabel ?? "닫기"}
      // data-role lets win98 (which paints its own chunky title-bar
      // X via [data-role="dialog-close-x"]) hide this modern variant
      // so the user doesn't see two X buttons stacked.
      data-role="modal-close"
      // Visual matches the kanban attachment X — red bevel + white
      // glyph — but slightly larger (h-8 w-8 vs h-6) since modal
      // close is a more prominent action than per-row attachment
      // dismissal. shadow + active:translate gives a tactile press.
      className={[
        // Base look + size (no position). Position lives in the
        // class block below so callers can override it cleanly.
        "inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-err/40 bg-err/85 text-white shadow transition-colors hover:bg-err select-none z-10",
        // Default position when the caller didn't supply one.
        // Caller-provided className REPLACES the default position
        // (rather than concatenating with it) so we don't end up
        // with both right-3 and right-4 fighting for the cascade.
        props.className ?? "absolute right-3 top-3",
      ].join(" ")}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M 2 2 L 10 10 M 10 2 L 2 10" />
      </svg>
    </span>
  );
}
