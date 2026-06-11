import type { ReactNode } from "react";
import type { ThemeMode } from "../lib/theme";

/* ── Section icons: 3 sets that adapt to the active theme ─────────────────
   • pixel       — win98
   • illustrated — kitsch / candy / toy
   • minimal     — dark / light / system
─────────────────────────────────────────────────────────────────────────── */

type SectionType = "backlog" | "planning" | "building" | "executing" | "analysis" | "review" | "done" | "custom";

function detectSectionType(title: string): SectionType {
  const t = title.toLowerCase();
  if (/(backlog|백로그|대기열|to.?do|할.?일)/.test(t)) return "backlog";
  if (/(plan|planning|계획|기획)/.test(t))            return "planning";
  if (/(build|빌드|개발|develop)/.test(t))            return "building";
  if (/(exec|run|executing|실행|실행중|in.?progress)/.test(t)) return "executing";
  if (/(analy|analysis|분석)/.test(t))                return "analysis";
  if (/(review|리뷰|검토)/.test(t))                    return "review";
  if (/(done|complete|완료|완성)/.test(t))             return "done";
  return "custom";
}

/* ── Pixel set (Win98) — crisp 16×16 with bitmap colours ── */
const PIXEL_PROPS = { width: 18, height: 18, viewBox: "0 0 16 16", fill: "none", shapeRendering: "crispEdges" as const };
function PixelFolder()    { return (<svg {...PIXEL_PROPS}><path d="M 1 4 L 6 4 L 7 5 L 15 5 L 15 13 L 1 13 Z" fill="#fbbf24" stroke="#000" strokeWidth="1"/><path d="M 2 6 L 14 6" stroke="#fde68a" strokeWidth="1"/><path d="M 1 12 L 15 12" stroke="#92400e" strokeWidth="1"/></svg>); }
function PixelNotepad()   { return (<svg {...PIXEL_PROPS}><rect x="2" y="1" width="10" height="13" fill="#ffffff" stroke="#000" strokeWidth="1"/><line x1="4" y1="4" x2="10" y2="4" stroke="#404040"/><line x1="4" y1="6" x2="10" y2="6" stroke="#404040"/><line x1="4" y1="8" x2="9" y2="8" stroke="#404040"/><path d="M 13 11 L 14 12 L 11 15 L 10 14 Z" fill="#facc15" stroke="#000"/><path d="M 10 14 L 11 15" stroke="#000"/></svg>); }
function PixelHammer()    { return (<svg {...PIXEL_PROPS}><rect x="2" y="2" width="9" height="4" fill="#c0c0c0" stroke="#000"/><line x1="2" y1="2" x2="11" y2="2" stroke="#ffffff"/><line x1="2" y1="3" x2="2" y2="5" stroke="#ffffff"/><rect x="6" y="6" width="2" height="9" fill="#92400e" stroke="#000"/><line x1="6" y1="7" x2="6" y2="14" stroke="#fbbf24"/></svg>); }
function PixelPlay()      { return (<svg {...PIXEL_PROPS}><rect x="1" y="1" width="14" height="14" fill="#c0c0c0" stroke="#000"/><path d="M 5 4 L 5 12 L 12 8 Z" fill="#16a34a" stroke="#000" strokeLinejoin="miter"/></svg>); }
function PixelChart()     { return (<svg {...PIXEL_PROPS}><rect x="0" y="0" width="16" height="16" fill="#ffffff" stroke="#000"/><rect x="2" y="9" width="3" height="5" fill="#3b82f6" stroke="#000"/><rect x="6" y="6" width="3" height="8" fill="#f97316" stroke="#000"/><rect x="10" y="3" width="3" height="11" fill="#16a34a" stroke="#000"/></svg>); }
function PixelChecklist() { return (<svg {...PIXEL_PROPS}><rect x="1" y="3" width="12" height="12" fill="#c0c0c0" stroke="#000"/><rect x="4" y="1" width="6" height="3" fill="#404040" stroke="#000"/><line x1="3" y1="6" x2="11" y2="6" stroke="#000"/><line x1="3" y1="9" x2="11" y2="9" stroke="#000"/><line x1="3" y1="12" x2="9" y2="12" stroke="#000"/><path d="M 9 7 L 10 8 L 12 6" stroke="#16a34a" strokeWidth="1.5" fill="none"/></svg>); }
function PixelCheckmark() { return (<svg {...PIXEL_PROPS}><rect x="1" y="1" width="14" height="14" fill="#c0c0c0" stroke="#000"/><path d="M 3 8 L 6 11 L 13 4" stroke="#16a34a" strokeWidth="2.5" fill="none" strokeLinecap="square" strokeLinejoin="miter"/></svg>); }
function PixelStarDoc()   { return (<svg {...PIXEL_PROPS}><rect x="2" y="1" width="10" height="13" fill="#ffffff" stroke="#000"/><path d="M 7 4 L 8 7 L 11 7 L 8.5 9 L 9.5 12 L 7 10 L 4.5 12 L 5.5 9 L 3 7 L 6 7 Z" fill="#fbbf24" stroke="#92400e" strokeWidth="0.6"/><line x1="3" y1="13" x2="11" y2="13" stroke="#404040"/></svg>); }

/* ── Minimal set (dark/light/system) — outline strokes, currentColor ── */
const MIN_PROPS = { width: 18, height: 18, viewBox: "0 0 20 20", fill: "none" };
const minStroke = { stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
function MinFolder()    { return (<svg {...MIN_PROPS}><path d="M 2 6 L 8 6 L 9 4 L 18 4 L 18 16 L 2 16 Z" {...minStroke}/></svg>); }
function MinNotepad()   { return (<svg {...MIN_PROPS}><rect x="3" y="2" width="14" height="16" rx="1.5" {...minStroke}/><line x1="6" y1="6" x2="14" y2="6" {...minStroke}/><line x1="6" y1="10" x2="14" y2="10" {...minStroke}/><line x1="6" y1="14" x2="11" y2="14" {...minStroke}/></svg>); }
function MinHammer()    { return (<svg {...MIN_PROPS}><circle cx="10" cy="10" r="3" {...minStroke}/><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.5 4.5l2 2M13.5 13.5l2 2M4.5 15.5l2-2M13.5 6.5l2-2" {...minStroke}/></svg>); }
function MinPlay()      { return (<svg {...MIN_PROPS}><circle cx="10" cy="10" r="8" {...minStroke}/><path d="M 8 7 L 14 10 L 8 13 Z" fill="currentColor" {...minStroke}/></svg>); }
function MinChart()     { return (<svg {...MIN_PROPS}><line x1="3" y1="17" x2="17" y2="17" {...minStroke}/><rect x="4" y="11" width="3" height="6" {...minStroke}/><rect x="9" y="7" width="3" height="10" {...minStroke}/><rect x="14" y="3" width="3" height="14" {...minStroke}/></svg>); }
function MinChecklist() { return (<svg {...MIN_PROPS}><rect x="4" y="3" width="12" height="14" rx="1.5" {...minStroke}/><path d="M 7 8 L 9 10 L 13 6" {...minStroke}/><line x1="7" y1="14" x2="13" y2="14" {...minStroke}/></svg>); }
function MinCheckmark() { return (<svg {...MIN_PROPS}><circle cx="10" cy="10" r="8" {...minStroke}/><path d="M 6 10 L 9 13 L 14 7" {...minStroke}/></svg>); }
function MinStarDoc()   { return (<svg {...MIN_PROPS}><rect x="4" y="2" width="12" height="16" rx="1.5" {...minStroke}/><path d="M 10 7 L 11 10 L 14 10 L 11.5 12 L 12.5 15 L 10 13 L 7.5 15 L 8.5 12 L 6 10 L 9 10 Z" {...minStroke}/></svg>); }

/* ── Toy set — hand-drawn sticker sheet, served as transparent PNGs.
   The PNGs live under /public/themes/toy/sections/{name}.png; they were
   cropped from the source sheet and had their cream sticker-base flood-
   filled to alpha 0, so they drop onto any background cleanly. ── */
function toyIcon(name: string) {
  return function ToyIcon() {
    // 40px so the hand-drawn sticker detail (bunny next to clipboard,
    // bear in the rocket, etc.) stays legible. SVG icons in the other
    // themes can read at 22px because they're vector primitives; raster
    // stickers need more room. object-contain prevents any clipping
    // regardless of the source PNG's aspect ratio.
    return (
      <img
        src={`/themes/toy/sections/${name}.png`}
        alt=""
        width={40}
        height={40}
        draggable={false}
        className="block h-10 w-10 object-contain"
      />
    );
  };
}
const ToyFolder    = toyIcon("backlog");
const ToyNotepad   = toyIcon("planning");
const ToyHammer    = toyIcon("building");
const ToyPlay      = toyIcon("executing");
const ToyChart     = toyIcon("analysis");
const ToyChecklist = toyIcon("review");
const ToyCheckmark = toyIcon("done");
const ToyStarDoc   = toyIcon("custom");

/* ── Kitsch set — pop-art sticker w/ hot-pink hard outlines + offset shadow ── */
const KIT_PROPS = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none" };
function KitFolder()    { return (<svg {...KIT_PROPS}><path d="M 5 9 L 10 9 L 12 7 L 22 7 L 22 20 L 5 20 Z" fill="#ff1a8c" opacity="0.30"/><path d="M 3 7 L 8 7 L 10 5 L 20 5 L 20 18 L 3 18 Z" fill="#ffffff" stroke="#ff1a8c" strokeWidth="3" strokeLinejoin="round"/><path d="M 3 9 L 20 9" stroke="#ff1a8c" strokeWidth="2"/></svg>); }
function KitNotepad()   { return (<svg {...KIT_PROPS}><rect x="6" y="5" width="13" height="17" fill="#ff1a8c" opacity="0.30"/><rect x="4" y="3" width="13" height="17" fill="#fde047" stroke="#ff1a8c" strokeWidth="3" strokeLinejoin="round"/><line x1="7" y1="8" x2="14" y2="8" stroke="#ff1a8c" strokeWidth="2.5" strokeLinecap="round"/><line x1="7" y1="12" x2="14" y2="12" stroke="#ff1a8c" strokeWidth="2.5" strokeLinecap="round"/><line x1="7" y1="16" x2="11" y2="16" stroke="#ff1a8c" strokeWidth="2.5" strokeLinecap="round"/></svg>); }
function KitHammer()    { return (<svg {...KIT_PROPS}><rect x="4" y="4" width="13" height="6" fill="#ff1a8c" opacity="0.30"/><rect x="2" y="2" width="13" height="6" fill="#fde047" stroke="#ff1a8c" strokeWidth="3" strokeLinejoin="round"/><rect x="11" y="10" width="3" height="12" fill="#ff1a8c" opacity="0.30"/><rect x="9" y="8" width="3" height="13" fill="#ff1a8c" stroke="#000" strokeWidth="2.5" strokeLinejoin="round"/></svg>); }
function KitPlay()      { return (<svg {...KIT_PROPS}><circle cx="14" cy="14" r="10" fill="#ff1a8c" opacity="0.30"/><circle cx="12" cy="12" r="10" fill="#fde047" stroke="#ff1a8c" strokeWidth="3"/><path d="M 9 7 L 17 12 L 9 17 Z" fill="#ff1a8c" stroke="#000" strokeWidth="2" strokeLinejoin="round"/></svg>); }
function KitChart()     { return (<svg {...KIT_PROPS}><rect x="4" y="6" width="20" height="17" fill="#ff1a8c" opacity="0.30"/><rect x="2" y="4" width="20" height="17" fill="#ffffff" stroke="#ff1a8c" strokeWidth="3" strokeLinejoin="round"/><rect x="5" y="13" width="3" height="6" fill="#22c55e" stroke="#000" strokeWidth="1.5"/><rect x="10" y="9" width="3" height="10" fill="#fde047" stroke="#000" strokeWidth="1.5"/><rect x="15" y="6" width="3" height="13" fill="#ff1a8c" stroke="#000" strokeWidth="1.5"/></svg>); }
function KitChecklist() { return (<svg {...KIT_PROPS}><rect x="5" y="7" width="14" height="16" fill="#ff1a8c" opacity="0.30"/><rect x="3" y="5" width="14" height="16" fill="#fde047" stroke="#ff1a8c" strokeWidth="3" strokeLinejoin="round"/><rect x="7" y="3" width="6" height="3" fill="#ff1a8c" stroke="#000" strokeWidth="2"/><line x1="6" y1="11" x2="14" y2="11" stroke="#000" strokeWidth="2" strokeLinecap="round"/><line x1="6" y1="15" x2="14" y2="15" stroke="#000" strokeWidth="2" strokeLinecap="round"/><path d="M 11.5 8 L 13 9.2 L 15 7" stroke="#22c55e" strokeWidth="2.6" fill="none" strokeLinecap="round"/></svg>); }
function KitCheckmark() { return (<svg {...KIT_PROPS}><circle cx="14" cy="14" r="10" fill="#000" opacity="0.30"/><circle cx="12" cy="12" r="10" fill="#ff1a8c" stroke="#000" strokeWidth="3"/><path d="M 7 12 L 11 16 L 17 8" stroke="#fde047" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>); }
function KitStarDoc()   { return (<svg {...KIT_PROPS}><rect x="6" y="5" width="13" height="17" fill="#ff1a8c" opacity="0.30"/><rect x="4" y="3" width="13" height="17" fill="#ffffff" stroke="#ff1a8c" strokeWidth="3" strokeLinejoin="round"/><path d="M 11 7 L 12.2 10 L 15.5 10 L 12.7 12 L 13.7 15.2 L 11 13.4 L 8.3 15.2 L 9.3 12 L 6.5 10 L 9.8 10 Z" fill="#fde047" stroke="#ff1a8c" strokeWidth="1.8" strokeLinejoin="round"/></svg>); }

/* ── Candy set — pastel glossy with soft outlines + white highlight ── */
const CDY_PROPS = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none" };
function CdyFolder()    { return (<svg {...CDY_PROPS}><path d="M 3 7 Q 3 5 5 5 L 9 5 L 11 7 L 19 7 Q 21 7 21 9 L 21 18 Q 21 20 19 20 L 5 20 Q 3 20 3 18 Z" fill="#bfdbfe" stroke="#7dd3fc" strokeWidth="1.6" strokeLinejoin="round"/><ellipse cx="8" cy="8" rx="3" ry="0.8" fill="#ffffff" opacity="0.7"/></svg>); }
function CdyNotepad()   { return (<svg {...CDY_PROPS}><rect x="4" y="3" width="13" height="18" rx="3" fill="#fbcfe8" stroke="#f9a8d4" strokeWidth="1.6"/><line x1="7" y1="8" x2="14" y2="8" stroke="#f9a8d4" strokeWidth="1.8" strokeLinecap="round"/><line x1="7" y1="12" x2="14" y2="12" stroke="#f9a8d4" strokeWidth="1.8" strokeLinecap="round"/><line x1="7" y1="16" x2="11" y2="16" stroke="#f9a8d4" strokeWidth="1.8" strokeLinecap="round"/><ellipse cx="6" cy="6" rx="1.4" ry="2" fill="#ffffff" opacity="0.75"/></svg>); }
function CdyHammer()    { return (<svg {...CDY_PROPS}><rect x="3" y="3" width="13" height="6" rx="2.5" fill="#a7f3d0" stroke="#6ee7b7" strokeWidth="1.6"/><rect x="9" y="9" width="3.5" height="12" rx="1.5" fill="#ddd6fe" stroke="#c4b5fd" strokeWidth="1.6"/><ellipse cx="6" cy="5" rx="2" ry="0.7" fill="#ffffff" opacity="0.7"/><ellipse cx="10" cy="11" rx="0.6" ry="2" fill="#ffffff" opacity="0.6"/></svg>); }
function CdyPlay()      { return (<svg {...CDY_PROPS}><circle cx="12" cy="12" r="10" fill="#a7f3d0" stroke="#6ee7b7" strokeWidth="1.6"/><path d="M 9 7 L 17 12 L 9 17 Z" fill="#ffffff" stroke="#6ee7b7" strokeWidth="1.4" strokeLinejoin="round"/><ellipse cx="9" cy="9" rx="2.5" ry="1" fill="#ffffff" opacity="0.55"/></svg>); }
function CdyChart()     { return (<svg {...CDY_PROPS}><rect x="2" y="4" width="20" height="17" rx="2.5" fill="#fef9c3" stroke="#fcd34d" strokeWidth="1.6"/><rect x="5" y="13" width="3" height="6" rx="1.2" fill="#bfdbfe"/><rect x="10" y="9" width="3" height="10" rx="1.2" fill="#fbcfe8"/><rect x="15" y="6" width="3" height="13" rx="1.2" fill="#a7f3d0"/></svg>); }
function CdyChecklist() { return (<svg {...CDY_PROPS}><rect x="3" y="5" width="14" height="16" rx="2.5" fill="#ddd6fe" stroke="#c4b5fd" strokeWidth="1.6"/><rect x="7" y="3" width="6" height="3" rx="1" fill="#fbcfe8" stroke="#f9a8d4" strokeWidth="1.4"/><line x1="6" y1="11" x2="14" y2="11" stroke="#c4b5fd" strokeWidth="1.6" strokeLinecap="round"/><line x1="6" y1="15" x2="14" y2="15" stroke="#c4b5fd" strokeWidth="1.6" strokeLinecap="round"/><path d="M 11.5 8 L 13 9.2 L 15 7" stroke="#6ee7b7" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>); }
function CdyCheckmark() { return (<svg {...CDY_PROPS}><circle cx="12" cy="12" r="10" fill="#a7f3d0" stroke="#6ee7b7" strokeWidth="1.6"/><path d="M 7 12 L 11 16 L 17 8" stroke="#ffffff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round"/><ellipse cx="9" cy="9" rx="2.5" ry="1.2" fill="#ffffff" opacity="0.5"/></svg>); }
function CdyStarDoc()   { return (<svg {...CDY_PROPS}><rect x="4" y="3" width="13" height="18" rx="2.5" fill="#fef9c3" stroke="#fcd34d" strokeWidth="1.6"/><path d="M 11 7 L 12.2 10 L 15.5 10 L 12.7 12 L 13.7 15.2 L 11 13.4 L 8.3 15.2 L 9.3 12 L 6.5 10 L 9.8 10 Z" fill="#fbcfe8" stroke="#f9a8d4" strokeWidth="1.2" strokeLinejoin="round"/><ellipse cx="6" cy="5" rx="1.2" ry="1.8" fill="#ffffff" opacity="0.7"/></svg>); }

const SECTION_ICONS: Record<SectionType, {
  pixel: () => ReactNode;
  toy: () => ReactNode;
  kitsch: () => ReactNode;
  candy: () => ReactNode;
  minimal: () => ReactNode;
}> = {
  backlog:   { pixel: PixelFolder,    toy: ToyFolder,    kitsch: KitFolder,    candy: CdyFolder,    minimal: MinFolder },
  planning:  { pixel: PixelNotepad,   toy: ToyNotepad,   kitsch: KitNotepad,   candy: CdyNotepad,   minimal: MinNotepad },
  building:  { pixel: PixelHammer,    toy: ToyHammer,    kitsch: KitHammer,    candy: CdyHammer,    minimal: MinHammer },
  executing: { pixel: PixelPlay,      toy: ToyPlay,      kitsch: KitPlay,      candy: CdyPlay,      minimal: MinPlay },
  analysis:  { pixel: PixelChart,     toy: ToyChart,     kitsch: KitChart,     candy: CdyChart,     minimal: MinChart },
  review:    { pixel: PixelChecklist, toy: ToyChecklist, kitsch: KitChecklist, candy: CdyChecklist, minimal: MinChecklist },
  done:      { pixel: PixelCheckmark, toy: ToyCheckmark, kitsch: KitCheckmark, candy: CdyCheckmark, minimal: MinCheckmark },
  custom:    { pixel: PixelStarDoc,   toy: ToyStarDoc,   kitsch: KitStarDoc,   candy: CdyStarDoc,   minimal: MinStarDoc },
};

function pickIconSet(theme: ThemeMode): "pixel" | "toy" | "kitsch" | "candy" | "minimal" {
  if (theme === "win98")  return "pixel";
  if (theme === "toy")    return "toy";
  if (theme === "kitsch") return "kitsch";
  if (theme === "candy")  return "candy";
  return "minimal";
}

function SectionIcon({ title, theme }: { title: string; theme: ThemeMode }) {
  const type = detectSectionType(title);
  const set = pickIconSet(theme);
  const Icon = SECTION_ICONS[type][set];
  return <Icon />;
}


export { SectionIcon };
