// BookmarkIcon — outline when inactive, filled when active. Both states
// inherit `currentColor`, so the parent's text-color class drives the
// theme tint (use `text-ac` on the parent for the accent fill).
export function BookmarkIcon({
  active,
  size = 14,
  className = "",
}: {
  active: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M 7 4 H 17 V 21 L 12 17 L 7 21 V 4 Z" />
    </svg>
  );
}
