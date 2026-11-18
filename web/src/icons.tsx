// Lucide icons used by the design (VocalLeaf V1.0.0.pen), inlined as SVG.
import type { ReactNode } from "react";

function Icon({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const UploadIcon = ({ size = 22 }) => (
  <Icon size={size}>
    <path d="M12 3v12" />
    <path d="m17 8-5-5-5 5" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </Icon>
);

export const ChevronLeftIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);

export const LoaderIcon = ({ size = 12 }) => (
  <Icon size={size}>
    <path d="M12 2v4" />
    <path d="m16.2 7.8 2.9-2.9" />
    <path d="M18 12h4" />
    <path d="m16.2 16.2 2.9 2.9" />
    <path d="M12 18v4" />
    <path d="m4.9 19.1 2.9-2.9" />
    <path d="M2 12h4" />
    <path d="m4.9 4.9 2.9 2.9" />
  </Icon>
);

export const AudioLinesIcon = ({ size = 14 }) => (
  <Icon size={size}>
    <path d="M2 10v3" />
    <path d="M6 6v11" />
    <path d="M10 3v18" />
    <path d="M14 8v7" />
    <path d="M18 5v13" />
    <path d="M22 10v3" />
  </Icon>
);

export const CircleAlertIcon = ({ size = 12 }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </Icon>
);

// Solid play / pause from the design's player (white on the green button), not Lucide outlines.
function SolidIcon({ size, d, className }: { size: number; d: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={d} />
    </svg>
  );
}

/** The triangle sits 1 px right of center to look centered (design note). */
export const PlaySolidIcon = ({ size = 16 }) => <SolidIcon size={size} d="M6 3l15 9-15 9z" className="play-glyph" />;

export const PauseSolidIcon = ({ size = 18 }) => <SolidIcon size={size} d="M6 4h4v16h-4z m8 0h4v16h-4z" />;

export const ArrowLeftIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </Icon>
);

/** Sentence sidebar collapsed: the plain split-panel icon; it opens the sidebar. */
export const PanelRightIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
  </Icon>
);

/** Sentence sidebar open: the split-panel icon with an arrow to the right; it collapses the sidebar. */
export const PanelRightCloseIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
    <path d="m8 9 3 3-3 3" />
  </Icon>
);

export const LocateFixedIcon = ({ size = 14 }) => (
  <Icon size={size}>
    <line x1="2" x2="5" y1="12" y2="12" />
    <line x1="19" x2="22" y1="12" y2="12" />
    <line x1="12" x2="12" y1="2" y2="5" />
    <line x1="12" x2="12" y1="19" y2="22" />
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

/**
 * The playing Chapter's sound wave (design 01 ①): four 1.5 px round-capped lines in ink, rising and falling while
 * playing and still while paused. 18 px.
 */
export const PlayingWave = ({ playing }: { playing: boolean }) => (
  <svg width={18} height={18} viewBox="0 0 16 16" aria-hidden="true" className={`wave${playing ? " is-playing" : ""}`}>
    {[3.2, 6.4, 9.6, 12.8].map((x) => (
      <line key={x} x1={x} x2={x} y1={2.5} y2={13.5} />
    ))}
  </svg>
);
