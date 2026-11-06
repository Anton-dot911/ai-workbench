const P = {
  docs: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  tWork: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  tLib: '<path d="M5 4v16M10 4v16M15 5l4 14"/>',
  tSet: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  save: '<path d="M6 4h10l3 3v13H6z"/><path d="M9 4v5h6V4M9 20v-6h6v6"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 15V6a2 2 0 012-2h8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  down: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  reuse: '<path d="M4 8h12l-3-3M20 16H8l3 3"/>',
} as const;

export type IconName = keyof typeof P;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: P[name] }}
    />
  );
}
