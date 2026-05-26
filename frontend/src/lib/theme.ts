export type ThemeMode = "dark" | "light" | "system" | "kitsch" | "candy" | "toy" | "win98";

export interface ThemeState {
  mode: ThemeMode;
  accentColor: string;   // hex, e.g. "#ff8a1d". Empty = use theme default.
  kitschName: string;    // display label for the kitsch mode button. Default "키치".
  kitschTextColor: string; // legacy: custom text color in kitsch mode. Use textColor going forward.
  toyChassisColor: string; // hex chassis tint in toy mode. Empty = default yellow.
  baseColor: string;     // user "전체색" for kitsch / candy. Empty = theme default.
  textColor: string;     // user "글씨색" for kitsch / candy / toy. Empty = theme default.
}

export const THEME_STORAGE_KEY = "floffi-theme";

export const DEFAULT_THEME: ThemeState = {
  mode: "light",
  accentColor: "#3b82f6",
  kitschName: "키치",
  kitschTextColor: "",
  toyChassisColor: "",
  baseColor: "",
  textColor: "",
};

/** Default toy chassis hex when user hasn't picked one. Matches the legacy
 *  hardcoded yellow palette so existing visuals are unchanged on upgrade. */
export const TOY_DEFAULT_CHASSIS = "#facc15";

/** Curated chassis swatches for the toy mode picker. Anything not in this
 *  list is still allowed via the freeform color input. */
export const TOY_CHASSIS_PRESETS: { label: string; hex: string }[] = [
  { label: "Yellow", hex: "#facc15" },
  { label: "Coral",  hex: "#fb923c" },
  { label: "Mint",   hex: "#34d399" },
  { label: "Sky",    hex: "#60a5fa" },
  { label: "Lilac",  hex: "#c084fc" },
  { label: "Rose",   hex: "#fb7185" },
];

/** Accent color presets */
export const ACCENT_PRESETS: { label: string; hex: string }[] = [
  { label: "Orange",  hex: "#ff8a1d" },
  { label: "Red",     hex: "#ef4444" },
  { label: "Pink",    hex: "#f43f8e" },
  { label: "Purple",  hex: "#8b5cf6" },
  { label: "Blue",    hex: "#3b82f6" },
  { label: "Cyan",    hex: "#06b6d4" },
  { label: "Forest",  hex: "#15803d" },
  { label: "Lime",    hex: "#84cc16" },
];

/** Theme default accent (used when accentColor is empty) */
export const THEME_DEFAULT_ACCENT: Record<ThemeMode, string> = {
  dark:   "#ff8a1d",
  light:  "#ff8a1d",
  system: "#ff8a1d",
  kitsch: "#ff1a8c",
  candy:  "#ff8ac0",
  toy:    "#dc2626",
  win98:  "#000080",
};

/** Theme default "전체색" (base background) for the custom panel preview.
 *  Only kitsch / candy / toy expose this to the user. */
export const THEME_DEFAULT_BASE: Partial<Record<ThemeMode, string>> = {
  kitsch: "#fffaf0",   // warm cream
  candy:  "#ebf6fc",   // baby blue tint
  toy:    "#facc15",   // toy chassis yellow (matches TOY_DEFAULT_CHASSIS)
};

/** Theme default "글씨색" for the custom panel preview. */
export const THEME_DEFAULT_TEXT: Partial<Record<ThemeMode, string>> = {
  kitsch: "#1c0530",   // deep purple
  candy:  "#3a4e6e",   // deep pastel navy
  toy:    "#451a03",   // deep brown
};

/** Mobile browser chrome color (address bar / status bar tint) per theme.
 *  Matches the real --base value from styles.css so the safe-area band
 *  blends with the page background instead of staying on a fixed orange. */
const THEME_MOBILE_CHROME: Record<Exclude<ThemeMode, "system">, string> = {
  dark:   "#080811",
  light:  "#f5f4fc",
  kitsch: "#fffaf0",
  candy:  "#ebf6fc",
  toy:    "#facc15",   // overridden by chassis color when set
  win98:  "#008080",   // classic teal desktop
};

export const THEME_LABELS: Record<ThemeMode, string> = {
  dark:   "다크",
  light:  "라이트",
  system: "시스템",
  kitsch: "키치",
  candy:  "캔디",
  toy:    "토이",
  win98:  "98",
};

/** Convert 6-digit hex → space-separated "R G B" for CSS variables */
export function hexToRgbParts(hex: string): string | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return `${r} ${g} ${b}`;
}

/** Lighten rgb values by factor (0–1) */
function lighter(r: number, g: number, b: number, f: number) {
  return [
    Math.min(255, Math.round(r + (255 - r) * f)),
    Math.min(255, Math.round(g + (255 - g) * f)),
    Math.min(255, Math.round(b + (255 - b) * f)),
  ];
}

/** Darken rgb values by factor (0–1) */
function darker(r: number, g: number, b: number, f: number) {
  return [
    Math.max(0, Math.round(r * (1 - f))),
    Math.max(0, Math.round(g * (1 - f))),
    Math.max(0, Math.round(b * (1 - f))),
  ];
}

/** Apply theme to <html> element */
export function applyTheme(state: ThemeState): void {
  const root = document.documentElement;

  // Resolve effective mode (system → dark/light based on OS)
  let effectiveMode: Exclude<ThemeMode, "system"> = state.mode === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : state.mode;

  root.setAttribute("data-theme", effectiveMode);

  // Apply custom accent or fall back to theme default
  const accentHex = state.accentColor || THEME_DEFAULT_ACCENT[state.mode];
  const parts = hexToRgbParts(accentHex);
  if (parts) {
    const [r, g, b] = parts.split(" ").map(Number);
    const [lr, lg, lb] = lighter(r, g, b, 0.2);
    const [dr, dg, db] = darker(r, g, b, 0.12);
    root.style.setProperty("--ac",    `${r}  ${g}  ${b}`);
    root.style.setProperty("--ac-lo", `${lr} ${lg} ${lb}`);
    root.style.setProperty("--ac-hi", `${dr} ${dg} ${db}`);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    root.style.setProperty("--ac-fg", lum > 0.6 ? "0 0 0" : "255 255 255");
  }

  // Toy: derive a small palette from the user's chassis color so the
  // styles.css rules can paint the body gradient, board shell, topbar,
  // and column surfaces from a single source-of-truth color. Variables
  // are cleared (and the styles.css defaults take over) when the mode
  // isn't toy, so picking a non-toy theme cleanly resets.
  const toyVars = [
    "--toy-chassis",
    "--toy-chassis-soft",
    "--toy-chassis-deep",
    "--toy-chassis-cream",
    "--toy-chassis-tint",
  ];
  for (const v of toyVars) root.style.removeProperty(v);
  if (effectiveMode === "toy") {
    const cp = hexToRgbParts(state.toyChassisColor || "#facc15");
    if (cp) {
      const [r, g, b] = cp.split(" ").map(Number);
      // soft = device exterior gradient mid stop; cream = inner LCD bg;
      // deep = bezel highlight / outer gradient stop; tint = subtle dust
      // used on sidebars and toast.
      const [sr, sg, sb] = lighter(r, g, b, 0.35);
      const [cr, cg, cb] = lighter(r, g, b, 0.78);
      const [dr, dg, db] = darker(r, g, b, 0.25);
      const [tr, tg, tb] = lighter(r, g, b, 0.88);
      root.style.setProperty("--toy-chassis",       `${r}  ${g}  ${b}`);
      root.style.setProperty("--toy-chassis-soft",  `${sr} ${sg} ${sb}`);
      root.style.setProperty("--toy-chassis-deep",  `${dr} ${dg} ${db}`);
      root.style.setProperty("--toy-chassis-cream", `${cr} ${cg} ${cb}`);
      root.style.setProperty("--toy-chassis-tint",  `${tr} ${tg} ${tb}`);
    }
  }

  // Clear base / text overrides on every apply — variables fall back to
  // the styles.css defaults when the mode doesn't support customization
  // or the user clears the picker.
  const baseVars = ["--base", "--s1", "--s2", "--s3", "--bd"];
  const textVars = ["--t1", "--t2", "--t3"];
  for (const v of baseVars) root.style.removeProperty(v);
  for (const v of textVars) root.style.removeProperty(v);
  root.style.removeProperty("--kitsch-sidebar");

  // "전체색" applies to kitsch + candy. Toy uses its own chassis pipeline
  // above (the chassis color *is* its base), so we don't paint --base here.
  if ((effectiveMode === "kitsch" || effectiveMode === "candy") && state.baseColor) {
    const bp = hexToRgbParts(state.baseColor);
    if (bp) {
      const [r, g, b] = bp.split(" ").map(Number);
      // s1 = card surface (slightly toward white), s2 = subtle tint,
      // s3 = a touch darker for hover states, bd = soft border.
      const [s1r, s1g, s1b] = lighter(r, g, b, 0.55);
      const [s2r, s2g, s2b] = lighter(r, g, b, 0.25);
      const [s3r, s3g, s3b] = darker(r, g, b, 0.05);
      const [bdr, bdg, bdb] = darker(r, g, b, 0.20);
      root.style.setProperty("--base", `${r} ${g} ${b}`);
      root.style.setProperty("--s1",   `${s1r} ${s1g} ${s1b}`);
      root.style.setProperty("--s2",   `${s2r} ${s2g} ${s2b}`);
      root.style.setProperty("--s3",   `${s3r} ${s3g} ${s3b}`);
      root.style.setProperty("--bd",   `${bdr} ${bdg} ${bdb}`);

      // Kitsch left + right sidebars: slightly lighter than the user's
      // base so both panels read as a paler wash of the overall tone
      // instead of staying on the hardcoded pale-pink/lilac. Candy keeps
      // its own glossy surface treatment, so this is kitsch-only.
      if (effectiveMode === "kitsch") {
        const [sbr, sbg, sbb] = lighter(r, g, b, 0.75);
        root.style.setProperty("--kitsch-sidebar", `${sbr} ${sbg} ${sbb}`);
      }
    }
  }

  // "글씨색" applies to kitsch / candy / toy. Kitsch keeps the legacy
  // kitschTextColor as a fallback so previously-saved settings still work.
  const textHex = state.textColor
    || (effectiveMode === "kitsch" ? state.kitschTextColor : "");
  if ((effectiveMode === "kitsch" || effectiveMode === "candy" || effectiveMode === "toy") && textHex) {
    const tp = hexToRgbParts(textHex);
    if (tp) {
      const [r, g, b] = tp.split(" ").map(Number);
      root.style.setProperty("--t1", tp);
      const [r2, g2, b2] = lighter(r, g, b, 0.30);
      root.style.setProperty("--t2", `${r2} ${g2} ${b2}`);
      const [r3, g3, b3] = lighter(r, g, b, 0.55);
      root.style.setProperty("--t3", `${r3} ${g3} ${b3}`);
    }
  }

  // Mobile browser chrome (iOS Safari address bar, Android status bar).
  // Without this, the <meta name="theme-color"> stays at the hardcoded
  // orange and bleeds through behind the page on phones even after the
  // user changes accent / base color.
  let chromeHex = "";
  if ((effectiveMode === "kitsch" || effectiveMode === "candy") && state.baseColor) {
    chromeHex = state.baseColor;
  } else if (effectiveMode === "toy") {
    chromeHex = state.toyChassisColor || THEME_MOBILE_CHROME.toy;
  } else {
    chromeHex = THEME_MOBILE_CHROME[effectiveMode];
  }
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = chromeHex;
}

// themeKey returns the localStorage key for `workspaceID`. Phase 11
// scopes theme per workspace so each one can look distinct (helps the
// user tell at a glance which workspace they're in when several are
// active). Empty workspaceID falls back to the legacy global key so
// pre-Phase-11 saves still load.
function themeKey(workspaceID: string): string {
  if (!workspaceID) return THEME_STORAGE_KEY;
  return `${THEME_STORAGE_KEY}:${workspaceID}`;
}

// loadTheme reads the saved theme for `workspaceID`. If nothing is
// stored under the workspace-scoped key, we fall back to the legacy
// global theme so a user who upgrades doesn't lose their settings —
// the global value seeds every workspace's first read. After that,
// each workspace evolves independently.
export function loadTheme(workspaceID: string = ""): ThemeState {
  const scoped = themeKey(workspaceID);
  try {
    const raw = localStorage.getItem(scoped);
    if (raw) return { ...DEFAULT_THEME, ...(JSON.parse(raw) as Partial<ThemeState>) };
  } catch {
    // ignore parse errors
  }
  // Workspace-scoped key missing — try the legacy global key as a
  // one-time seed. Worth not clobbering the legacy key here: if the
  // user is on multiple devices, the other device might still be on
  // an older client that reads the global key.
  if (workspaceID) {
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      if (raw) return { ...DEFAULT_THEME, ...(JSON.parse(raw) as Partial<ThemeState>) };
    } catch {
      // ignore
    }
  }
  return { ...DEFAULT_THEME };
}

export function saveTheme(state: ThemeState, workspaceID: string = ""): void {
  localStorage.setItem(themeKey(workspaceID), JSON.stringify(state));
}
