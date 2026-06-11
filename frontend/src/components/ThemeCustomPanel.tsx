import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "../lib/escapeStack";
import { ACCENT_PRESETS, THEME_DEFAULT_BASE, THEME_DEFAULT_TEXT, TOY_CHASSIS_PRESETS, TOY_DEFAULT_CHASSIS, hexToRgbParts } from "../lib/theme";
import type { ThemeState } from "../lib/theme";

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function normalizeHex(hex: string, fallback: string): string {
  const h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(h)) return `#${h.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(h)) return `#${h.split("").map((c) => c + c).join("").toLowerCase()}`;
  return fallback;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const parts = hexToRgbParts(hex);
  if (!parts) return { r: 0, g: 0, b: 0 };
  const [r, g, b] = parts.split(" ").map(Number);
  return { r, g, b };
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0, gp = 0, bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: clampByte((rp + m) * 255), g: clampByte((gp + m) * 255), b: clampByte((bp + m) * 255) };
}

function ColorPicker(props: {
  value: string;
  fallback: string;
  onChange: (hex: string) => void;
  onCommit?: () => void;
  title?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const effective = normalizeHex(props.value || props.fallback, "#000000");

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={props.title ?? "색상 선택"}
        className="h-9 w-9 shrink-0 cursor-pointer rounded-full border-2 border-bd/15 p-1 transition hover:border-ac/40"
      >
        <span className="block h-full w-full rounded-full" style={{ background: effective }} />
      </button>
      {open ? (
        <ColorPickerPopover
          anchor={btnRef.current}
          value={effective}
          onChange={props.onChange}
          onClose={() => setOpen(false)}
          onCommit={() => { setOpen(false); props.onCommit?.(); }}
        />
      ) : null}
    </>
  );
}

function ColorPickerPopover(props: {
  anchor: HTMLElement | null;
  value: string;
  onChange: (hex: string) => void;
  onClose: () => void;
  onCommit: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const squareRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<null | "square" | "hue">(null);
  useEscapeClose(true, props.onClose);

  const { r, g, b } = hexToRgb(props.value);
  const [hsv, setHsv] = useState(() => rgbToHsv(r, g, b));
  const lastHexRef = useRef(props.value);
  useEffect(() => {
    if (props.value !== lastHexRef.current) {
      const c = hexToRgb(props.value);
      setHsv(rgbToHsv(c.r, c.g, c.b));
      lastHexRef.current = props.value;
    }
  }, [props.value]);

  const commitHsv = (next: { h: number; s: number; v: number }) => {
    setHsv(next);
    const c = hsvToRgb(next.h, next.s, next.v);
    const hex = rgbToHex(c.r, c.g, c.b);
    lastHexRef.current = hex;
    props.onChange(hex);
  };

  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useEffect(() => {
    function place() {
      const a = props.anchor;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const width = 268;
      let left = rect.left;
      if (left + width > window.innerWidth - 12) left = window.innerWidth - 12 - width;
      if (left < 12) left = 12;
      setPos({ top: rect.bottom + 8, left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [props.anchor]);

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

  const updateFromSquare = (clientX: number, clientY: number) => {
    const el = squareRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    commitHsv({ ...hsv, s, v });
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current === "square") updateFromSquare(e.clientX, e.clientY);
    };
    const onUp = () => { dragging.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  });

  const cur = hsvToRgb(hsv.h, hsv.s, hsv.v);
  const curHex = rgbToHex(cur.r, cur.g, cur.b);
  const hue = hsvToRgb(hsv.h, 1, 1);
  const hueHex = rgbToHex(hue.r, hue.g, hue.b);

  return createPortal(
    <div
      ref={rootRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: 268 }}
      className="z-[70] rounded-2xl border-2 border-bd/15 bg-s1 p-3 shadow-2xl"
      role="dialog"
      aria-label="색상 선택"
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); props.onCommit(); }
      }}
    >
      <div
        ref={squareRef}
        className="relative h-36 w-full cursor-crosshair rounded-xl"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex})` }}
        onPointerDown={(e) => { dragging.current = "square"; updateFromSquare(e.clientX, e.clientY); }}
      >
        <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: curHex }} />
      </div>

      <input
        type="range" min={0} max={360} step={1} value={Math.round(hsv.h)}
        onChange={(e) => commitHsv({ ...hsv, h: Number(e.target.value) })}
        className="color-hue-slider mt-3 h-3 w-full cursor-pointer appearance-none rounded-full"
      />

      <div className="mt-3 flex items-center gap-2">
        <span className="h-7 w-7 shrink-0 rounded-full border border-bd/15" style={{ background: curHex }} aria-hidden />
        <input
          type="text"
          value={curHex}
          onChange={(e) => {
            const hex = normalizeHex(e.target.value, "");
            if (hex) { const c = hexToRgb(hex); commitHsv(rgbToHsv(c.r, c.g, c.b)); }
          }}
          className="min-w-0 flex-1 rounded-lg border border-bd/10 bg-s2 px-2 py-1.5 text-xs font-semibold uppercase text-t1 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15"
        />
      </div>
      <div className="mt-3 space-y-2">
        {(["r", "g", "b"] as const).map((ch) => {
          const lo = rgbToHex(ch === "r" ? 0 : cur.r, ch === "g" ? 0 : cur.g, ch === "b" ? 0 : cur.b);
          const hi = rgbToHex(ch === "r" ? 255 : cur.r, ch === "g" ? 255 : cur.g, ch === "b" ? 255 : cur.b);
          const setChannel = (val: number) => {
            const next = { r: cur.r, g: cur.g, b: cur.b, [ch]: clampByte(val) };
            commitHsv(rgbToHsv(next.r, next.g, next.b));
          };
          return (
            <div key={ch} className="flex items-center gap-2">
              <span className="w-3 shrink-0 text-[10px] font-black uppercase text-t3">{ch}</span>
              <input
                type="range" min={0} max={255} step={1} value={cur[ch]}
                onChange={(e) => setChannel(Number(e.target.value))}
                className="color-rgb-slider h-3 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
                style={{ background: `linear-gradient(to right, ${lo}, ${hi})` }}
              />
              <input
                type="text" inputMode="numeric" value={cur[ch]}
                onChange={(e) => setChannel(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
                className="color-rgb-num w-12 shrink-0 rounded-lg border border-bd/10 bg-s2 px-1 py-1 text-center text-xs font-semibold tabular-nums text-t1 outline-none transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15"
              />
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

type RevertInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "onKeyDown" | "onFocus"> & {
  value: string;
  onChangeValue: (v: string) => void;
  onCommit?: () => void;
};

function RevertInput({ value, onChangeValue, onCommit, ...rest }: RevertInputProps) {
  const originRef = useRef(value);
  return (
    <input
      {...rest}
      value={value}
      onChange={(e) => onChangeValue(e.target.value)}
      onFocus={() => { originRef.current = value; }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); onCommit?.(); e.currentTarget.blur(); }
        if (e.key === "Escape") { e.preventDefault(); onChangeValue(originRef.current); e.currentTarget.blur(); }
      }}
    />
  );
}

function AccentPicker(props: {
  themeState: ThemeState;
  onAccentColorChange: (color: string) => void;
  onCommit?: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold text-t3">강조색</p>
      <div className="flex flex-wrap gap-2">
        {ACCENT_PRESETS.map((preset) => {
          const isActive = props.themeState.accentColor === preset.hex;
          return (
            <button key={preset.hex} type="button" data-role="color-swatch" onClick={() => props.onAccentColorChange(preset.hex)} title={preset.label} className={["h-7 w-7 rounded-lg transition hover:scale-110", isActive ? "ring-2 ring-t1 ring-offset-1 ring-offset-s1" : ""].join(" ")} style={{ background: preset.hex }} />
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <ColorPicker value={props.themeState.accentColor} fallback="#ff8a1d" onChange={props.onAccentColorChange} onCommit={props.onCommit} title="강조색 선택" />
        <RevertInput type="text" value={props.themeState.accentColor} onChangeValue={(v) => { if (/^#[0-9a-fA-F]{0,6}$/.test(v)) props.onAccentColorChange(v); }} onCommit={props.onCommit} placeholder="#ff8a1d" className="min-w-0 flex-1 rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-xs font-semibold text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15" />
        <button type="button" onClick={() => props.onAccentColorChange("")} className="rounded-xl border border-bd/10 bg-s2 px-2 py-2 text-xs text-t3 transition hover:text-t1">초기화</button>
      </div>
    </div>
  );
}

export function ThemeCustomPanel(props: {
  themeState: ThemeState;
  onAccentColorChange: (color: string) => void;
  onBaseColorChange: (color: string) => void;
  onTextColorChange: (color: string) => void;
  onToyChassisColorChange: (color: string) => void;
  onKitschNameChange: (name: string) => void;
}) {
  const mode = props.themeState.mode;
  const themed = mode === "kitsch" || mode === "candy" || mode === "toy";
  const baseValue = mode === "toy" ? props.themeState.toyChassisColor : props.themeState.baseColor;
  const setBase = mode === "toy" ? props.onToyChassisColorChange : props.onBaseColorChange;
  const baseDefault = mode === "toy" ? TOY_DEFAULT_CHASSIS : (THEME_DEFAULT_BASE[mode] || "#ffffff");
  const textDefault = THEME_DEFAULT_TEXT[mode] || "#000000";
  const textValue = props.themeState.textColor || (mode === "kitsch" ? props.themeState.kitschTextColor : "");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!themed) {
    return (
      <div className="space-y-3 border-t border-bd/10 pt-3">
        <AccentPicker themeState={props.themeState} onAccentColorChange={props.onAccentColorChange} />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="border-t border-bd/10 pt-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-[11px] font-bold text-t2 transition hover:bg-s3 hover:text-t1">
        <span className="uppercase tracking-wider">커스텀</span>
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-full border border-bd/20" style={{ background: props.themeState.accentColor || "#ff8a1d" }} />
            <span className="h-3 w-3 rounded-full border border-bd/20" style={{ background: baseValue || baseDefault }} />
            <span className="h-3 w-3 rounded-full border border-bd/20" style={{ background: textValue || textDefault }} />
          </span>
          <span className={["text-[10px] transition", open ? "rotate-180" : ""].join(" ")}>▾</span>
        </span>
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-50" aria-hidden onMouseDown={() => setOpen(false)} />
          <div className="relative z-[51] mt-3 space-y-4 rounded-xl border border-bd/10 bg-s2/40 p-3">
            <AccentPicker themeState={props.themeState} onAccentColorChange={props.onAccentColorChange} onCommit={() => setOpen(false)} />

            <div className="space-y-2 border-t border-bd/10 pt-3">
              <p className="text-[11px] font-bold text-t3">전체색</p>
              {mode === "toy" ? (
                <div className="flex flex-wrap gap-2">
                  {TOY_CHASSIS_PRESETS.map((preset) => {
                    const isActive = (baseValue || baseDefault) === preset.hex;
                    return (
                      <button key={preset.hex} type="button" data-role="color-swatch" onClick={() => setBase(preset.hex)} title={preset.label} className={["h-7 w-7 rounded-lg transition hover:scale-110", isActive ? "ring-2 ring-t1 ring-offset-1 ring-offset-s1" : ""].join(" ")} style={{ background: preset.hex }} />
                    );
                  })}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <ColorPicker value={baseValue} fallback={baseDefault} onChange={setBase} onCommit={() => setOpen(false)} title="전체색 선택" />
                <RevertInput type="text" value={baseValue} onChangeValue={(v) => { if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setBase(v); }} onCommit={() => setOpen(false)} placeholder={baseDefault} className="min-w-0 flex-1 rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-xs font-semibold text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15" />
                <button type="button" onClick={() => setBase("")} className="shrink-0 whitespace-nowrap rounded-xl border border-bd/10 bg-s2 px-2 py-2 text-xs text-t3 transition hover:text-t1">초기화</button>
              </div>
            </div>

            <div className="space-y-2 border-t border-bd/10 pt-3">
              <p className="text-[11px] font-bold text-t3">글씨색</p>
              <div className="flex items-center gap-2">
                <ColorPicker value={textValue} fallback={textDefault} onChange={props.onTextColorChange} onCommit={() => setOpen(false)} title="글씨색 선택" />
                <RevertInput type="text" value={textValue} onChangeValue={(v) => { if (/^#[0-9a-fA-F]{0,6}$/.test(v)) props.onTextColorChange(v); }} onCommit={() => setOpen(false)} placeholder={textDefault} className="min-w-0 flex-1 rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-xs font-semibold text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15" />
                <button type="button" onClick={() => props.onTextColorChange("")} className="shrink-0 whitespace-nowrap rounded-xl border border-bd/10 bg-s2 px-2 py-2 text-xs text-t3 transition hover:text-t1">초기화</button>
              </div>
            </div>

            {mode === "kitsch" ? (
              <div className="space-y-2 border-t border-bd/10 pt-3">
                <p className="text-[11px] font-bold text-t3">키치 테마 이름</p>
                <RevertInput value={props.themeState.kitschName} onChangeValue={props.onKitschNameChange} placeholder="키치" className="w-full rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-xs text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15" />
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
