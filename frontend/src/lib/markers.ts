// Task markers — currently a single "bookmark" type used as a flag for
// tasks the user wants to revisit later. The data model on task.markers
// stays open (string[]) so future marker types ("important", "reference",
// etc.) can be added by extending MARKER_CATALOG without a schema change.
//
// Visual representation is intentionally simple: the BookmarkIcon component
// renders an outline when inactive and a filled (accent-colored) glyph when
// active. No image assets, no fallback glyphs — pure SVG path with state-
// driven fill, themed via the parent's text color.

export type MarkerId = "bookmark";

export type MarkerDef = {
  id: MarkerId;
  label: string; // Korean UI label shown on hover / aria
};

export const MARKER_CATALOG: Record<MarkerId, MarkerDef> = {
  bookmark: { id: "bookmark", label: "북마크" },
};

export const MARKER_IDS: readonly MarkerId[] = ["bookmark"];

export function isMarkerId(value: string): value is MarkerId {
  return (MARKER_IDS as readonly string[]).includes(value);
}

export function hasMarker(task: { markers?: string[] }, marker: MarkerId): boolean {
  return Array.isArray(task.markers) && task.markers.includes(marker);
}

// toggleMarkerInList returns a new list with the given marker added or
// removed. Pure function so callers can pass it straight into setState.
export function toggleMarkerInList(markers: string[] | undefined, marker: MarkerId): string[] {
  const list = Array.isArray(markers) ? [...markers] : [];
  const idx = list.indexOf(marker);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(marker);
  return list;
}
