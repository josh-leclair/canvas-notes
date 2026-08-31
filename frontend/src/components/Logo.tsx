/** Three cards, two links: the whole app in one mark. */
export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--link-follows_from)" />
        </linearGradient>
      </defs>
      <path
        d="M9.5 9.5 L22 6.5 M9.5 9.5 L20.5 23"
        stroke="url(#brand-g)"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity="0.55"
      />
      <rect x="3" y="4" width="13" height="10" fill="url(#brand-g)" />
      <rect
        x="19"
        y="3"
        width="10"
        height="8"
        fill="none"
        stroke="url(#brand-g)"
        strokeWidth="2"
      />
      <rect
        x="16"
        y="19"
        width="13"
        height="10"
        fill="none"
        stroke="url(#brand-g)"
        strokeWidth="2"
      />
    </svg>
  );
}
