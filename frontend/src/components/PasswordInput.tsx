import { useState } from "react";
import type { KeyboardEvent } from "react";

// PasswordInput — masked text input with a show/hide eye toggle in the
// trailing slot. Used by LoginView + SignupView so the masking
// behavior, padding, and toggle affordance stay in one place.
//
// The reveal state is local to each instance — toggling the password
// field doesn't reveal the "비밀번호 확인" field, and vice versa. That
// matches how users actually want this: you usually want to peek at
// the field you just typed, not every password on the page.
type Props = {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  // autoComplete should be "current-password" on login and
  // "new-password" on signup, per the WHATWG spec — keeps password
  // managers from suggesting the wrong thing.
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  // Accessible label fragment used by both the button's aria-label
  // ("비밀번호 표시" / "비밀번호 숨김") and SR users navigating the
  // confirm field, where there are two password inputs on one page.
  ariaLabel?: string;
};

export function PasswordInput(props: Props) {
  const [shown, setShown] = useState(false);
  const labelBase = props.ariaLabel ?? "비밀번호";
  return (
    <div className="relative">
      <input
        type={shown ? "text" : "password"}
        // pr-11 leaves room for the toggle button at the right edge so
        // the user's typing never slides under the icon.
        className="w-full rounded-xl border-2 border-bd/10 px-4 py-3 pr-11 text-t1 outline-none ring-0 placeholder:text-t3 focus:outline-none focus:ring-0 focus-visible:outline-none"
        style={{
          background:
            "color-mix(in srgb, rgb(var(--base)) 92%, rgb(var(--ac)) 8%)",
        }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onKeyDown}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        aria-label={labelBase}
      />
      <span
        // Rendered as <span role="button"> rather than <button>
        // because every theme in styles.css (candy / toy / kitsch /
        // win98) has aggressive `button { ... !important }` rules,
        // and even the `data-role="icon-btn"` escape hatch carries
        // its own pill background + shadow meant for chunky
        // BoardView toolbar buttons. The password reveal sits INSIDE
        // an input, where any of those surfaces would render as a
        // pill-shaped eyeball stuffed into the field. A span carries
        // no theme baggage. We retain the button semantics with
        // role="button" + a click handler + Enter/Space keyboard
        // activation, so SR users and keyboard users still get a
        // working control.
        role="button"
        // tabIndex={-1} keeps the toggle off the Tab order — a
        // mouse user can still click it, but Tab from the password
        // input lands on the next form field, not this peek glyph.
        tabIndex={-1}
        onClick={() => setShown((s) => !s)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setShown((s) => !s);
          }
        }}
        aria-label={shown ? `${labelBase} 숨김` : `${labelBase} 표시`}
        aria-pressed={shown}
        // Plain glyph in the trailing slot. h-8 w-8 is the click
        // target only; nothing visual is painted on it.
        className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 cursor-pointer items-center justify-center text-t3 transition-colors hover:text-t1 select-none"
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </span>
    </div>
  );
}

// Inline SVGs — no extra dep. Stroke-based icons that read at 16px and
// scale up cleanly. currentColor lets the parent control the hue via
// text-* classes.
function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.7" />
      <path d="M6.3 7.7A17 17 0 0 0 2 12s3.5 6 10 6a10 10 0 0 0 4-.8" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
