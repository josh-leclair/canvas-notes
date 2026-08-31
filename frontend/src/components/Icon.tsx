/** One drawn set, replacing the unicode glyphs the interface grew up with.
 *
 * `⋯`, `▶`, `⤢`, `✕`, `◀`, `■`, `●` came from seven different corners of the
 * character set: different weights, different optical sizes, different
 * baselines. Individually forgivable, together they read as unfinished.
 *
 * Drawn inline rather than pulled from an icon font, for the same reason the
 * type stack is system-only — a self-hosted instance may have no internet at
 * all. Every glyph is a 24×24 box, stroked in `currentColor`, so an icon
 * inherits the colour and size of whatever it sits in.
 */
export type IconName =
  | "more"
  | "play"
  | "pause"
  | "record"
  | "stop"
  | "expand"
  | "close"
  | "chevronLeft"
  | "chevronRight"
  | "search"
  | "share"
  | "note"
  | "audio"
  | "column"
  | "board"
  | "portal"
  | "image"
  | "file"
  | "download"
  | "theme"
  | "checklist"
  | "table"
  | "document"
  | "edit"
  | "textStyle"
  | "check";

/* Most of the set is drawn as strokes on a 24-unit grid. A few come from
 * elsewhere and are solid shapes on a grid of their own, so they bring their
 * own viewBox and are filled rather than stroked. */
const VIEWBOX: Partial<Record<IconName, string>> = {
  document: "0 0 470.586 470.586",
};
const FILLED = new Set<IconName>(["document"]);

const PATHS: Record<IconName, JSX.Element> = {
  edit: (
    <>
      <path d="M5 19l3.5-.8L18 7.7 14.3 4 4.8 14.5 4 18z" />
      <path d="M12.8 5.7l3.6 3.6" />
    </>
  ),
  textStyle: (
    <>
      <path d="M4 6h11M9.5 6v12" />
      <circle cx="18.5" cy="16.5" r="2.6" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  expand: <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevronLeft: <path d="M14.5 5L8 12l6.5 7" />,
  chevronRight: <path d="M9.5 5L16 12l-6.5 7" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5L20 20" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8l7.6-4.5M8.2 13.2l7.6 4.5" />
    </>
  ),
  note: (
    <>
      <path d="M5 4.5h9l5 5V19a.5.5 0 01-.5.5h-13A.5.5 0 015 19V5a.5.5 0 010-.5z" />
      <path d="M13.5 4.5V10h5.5M8.5 13.5h7M8.5 16.5h4.5" />
    </>
  ),
  audio: (
    <>
      <path d="M12 4.5a2.5 2.5 0 012.5 2.5v5a2.5 2.5 0 01-5 0V7A2.5 2.5 0 0112 4.5z" />
      <path d="M6.5 11.5A5.5 5.5 0 0012 17a5.5 5.5 0 005.5-5.5M12 17v2.5" />
    </>
  ),
  column: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2" />
      <path d="M4.5 9h15M8 12.5h8M8 15.5h8" />
    </>
  ),
  board: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2" />
      <path d="M12 4.5v15M4.5 12h7.5" />
    </>
  ),
  portal: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
      <path d="M8 8h8v8H8zM16 8l3.5-3.5M16 8h3.5V4.5" />
    </>
  ),
  image: (
    <>
      <rect x="4.5" y="5.5" width="15" height="13" rx="2" />
      <circle cx="9" cy="10" r="1.4" />
      <path d="M5 16l4-4 3.5 3.5L15.5 12l3.5 4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h7.5L18 8v12a.5.5 0 01-.5.5h-11A.5.5 0 016 20V4a.5.5 0 010-.5z" />
      <path d="M13.5 3.5V8H18" />
    </>
  ),
  download: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />,
  checklist: (
    <>
      <path d="M4.5 7.5l2 2 3.5-3.5M4.5 16.5l2 2 3.5-3.5" />
      <path d="M13.5 8h6M13.5 17h6" />
    </>
  ),
  table: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.6" />
      <path d="M4 9.5h16M9.5 9.5V19M15 9.5V19" />
    </>
  ),
  document: <path d="M327.081,0H90.234c-15.9,0-28.854,12.959-28.854,28.859v412.863c0,15.924,12.953,28.863,28.854,28.863H380.35 c15.917,0,28.855-12.939,28.855-28.863V89.234L327.081,0z M333.891,43.184l35.996,39.121h-35.996V43.184z M384.972,441.723 c0,2.542-2.081,4.629-4.634,4.629H90.234c-2.551,0-4.62-2.087-4.62-4.629V28.859c0-2.548,2.069-4.613,4.62-4.613h219.41v70.181 c0,6.682,5.444,12.099,12.129,12.099h63.198V441.723z M131.858,161.048l-25.29-99.674h18.371l11.688,49.795 c1.646,6.954,3.23,14.005,4.592,20.516c1.555-6.682,3.425-13.774,5.272-20.723l13.122-49.583h16.863l11.969,49.929 c1.552,6.517,3.094,13.243,4.395,19.742c1.339-5.784,2.823-11.718,4.348-17.83l0.562-2.217l12.989-49.618h17.996l-28.248,99.673 h-16.834l-12.395-51.173c-1.531-6.289-2.87-12.052-3.975-17.693c-1.292,5.618-2.799,11.366-4.643,17.794l-13.964,51.072h-16.819 V161.048z M242.607,139.863h108.448c5.013,0,9.079,4.069,9.079,9.079c0,5.012-4.066,9.079-9.079,9.079H242.607 c-5.012,0-9.079-4.067-9.079-9.079C233.529,143.933,237.596,139.863,242.607,139.863z M360.135,209.566 c0,5.012-4.066,9.079-9.079,9.079H125.338c-5.012,0-9.079-4.067-9.079-9.079c0-5.013,4.066-9.079,9.079-9.079h225.718 C356.068,200.487,360.135,204.554,360.135,209.566z M360.135,263.283c0,5.012-4.066,9.079-9.079,9.079H125.338 c-5.012,0-9.079-4.067-9.079-9.079c0-5.013,4.066-9.079,9.079-9.079h225.718C356.068,254.204,360.135,258.271,360.135,263.283z M360.135,317c0,5.013-4.066,9.079-9.079,9.079H125.338c-5.012,0-9.079-4.066-9.079-9.079c0-5.012,4.066-9.079,9.079-9.079h225.718 C356.068,307.921,360.135,311.988,360.135,317z M360.135,371.474c0,5.013-4.066,9.079-9.079,9.079H125.338 c-5.012,0-9.079-4.066-9.079-9.079s4.066-9.079,9.079-9.079h225.718C356.068,362.395,360.135,366.461,360.135,371.474z" />,
  theme: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 4.5a7.5 7.5 0 000 15z" fill="currentColor" stroke="none" />
    </>
  ),
};

export default function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox={VIEWBOX[name] ?? "0 0 24 24"}
      fill={FILLED.has(name) ? "currentColor" : "none"}
      stroke={FILLED.has(name) ? "none" : "currentColor"}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
