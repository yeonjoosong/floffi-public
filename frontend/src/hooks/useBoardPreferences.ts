import { useEffect, useRef, useState } from "react";
import { isMarkerId, type MarkerId } from "../lib/markers";

export type ColumnsPerRow = "auto" | "1" | "2" | "3" | "4";

const COLLAPSED_SECTIONS_KEY = "floffi-collapsed-sections";
const FORCE_COMPACT_KEY = "floffi-force-compact";
const MARKER_FILTER_KEY = "floffi-marker-filter";
const COLS_PER_ROW_KEY = "floffi-cols-per-row";
const MINI_CARDS_KEY = "floffi-mini-cards";

function loadForceCompact(): boolean {
  try { return localStorage.getItem(FORCE_COMPACT_KEY) === "1"; } catch { return false; }
}

function loadCollapsedSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {}
  return {};
}

function saveCollapsedSections(state: Record<string, boolean>) {
  try { localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(state)); } catch {}
}

function loadMarkerFilter(): MarkerId | null {
  try {
    const raw = localStorage.getItem(MARKER_FILTER_KEY);
    if (raw && isMarkerId(raw)) return raw;
  } catch {}
  return null;
}

function saveMarkerFilter(value: MarkerId | null) {
  try {
    if (value) localStorage.setItem(MARKER_FILTER_KEY, value);
    else localStorage.removeItem(MARKER_FILTER_KEY);
  } catch {}
}

export function useBoardPreferences(resetSignal: number) {
  const [forceCompact, setForceCompact] = useState<boolean>(loadForceCompact);
  useEffect(() => {
    try {
      if (forceCompact) localStorage.setItem(FORCE_COMPACT_KEY, "1");
      else localStorage.removeItem(FORCE_COMPACT_KEY);
    } catch {}
  }, [forceCompact]);

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(loadCollapsedSections);
  useEffect(() => { saveCollapsedSections(collapsedSections); }, [collapsedSections]);

  const resetSignalRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignalRef.current === resetSignal) return;
    resetSignalRef.current = resetSignal;
    setCollapsedSections({});
  }, [resetSignal]);

  const toggleSectionCollapsed = (sectionId: string) => {
    setCollapsedSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  const [markerFilter, setMarkerFilter] = useState<MarkerId | null>(loadMarkerFilter);
  useEffect(() => { saveMarkerFilter(markerFilter); }, [markerFilter]);

  const [columnsPerRow, setColumnsPerRow] = useState<ColumnsPerRow>(() => {
    try {
      const raw = localStorage.getItem(COLS_PER_ROW_KEY);
      if (raw === "auto" || raw === "1" || raw === "2" || raw === "3" || raw === "4") return raw;
    } catch {}
    return "auto";
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_PER_ROW_KEY, columnsPerRow); } catch {}
  }, [columnsPerRow]);

  const [miniCards, setMiniCards] = useState<boolean>(() => {
    try { return localStorage.getItem(MINI_CARDS_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try {
      if (miniCards) localStorage.setItem(MINI_CARDS_KEY, "1");
      else localStorage.removeItem(MINI_CARDS_KEY);
    } catch {}
  }, [miniCards]);

  const [isNarrowViewport, setIsNarrowViewport] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = (event: MediaQueryListEvent) => setIsNarrowViewport(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isMobileLike = isNarrowViewport || forceCompact;
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [boardWidth, setBoardWidth] = useState<number>(0);
  useEffect(() => {
    const element = boardRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    setBoardWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setBoardWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const colFloor = isMobileLike ? (miniCards ? 72 : 160) : 240;
  const colGap = isMobileLike ? 12 : 16;
  const maxFittingColumns = boardWidth > 0
    ? Math.max(1, Math.min(4, Math.floor((boardWidth + colGap) / (colFloor + colGap))))
    : 4;
  const userPick: ColumnsPerRow = (isMobileLike && !miniCards && (columnsPerRow === "3" || columnsPerRow === "4")) ? "2" : columnsPerRow;
  const effectiveColumns: ColumnsPerRow = userPick === "auto" || userPick === "1"
    ? userPick
    : (Number(userPick) > maxFittingColumns ? (String(maxFittingColumns) as ColumnsPerRow) : userPick);

  return {
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
  };
}
