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

export const MailIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
    <rect x="2" y="4" width="20" height="16" rx="2" />
  </Icon>
);

export const LockIcon = ({ size = 13 }) => (
  <Icon size={size}>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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

export const RotateCwIcon = ({ size = 12 }) => (
  <Icon size={size}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </Icon>
);

export const ArrowLeftIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </Icon>
);

export const PanelRightIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
  </Icon>
);

export const PanelRightCloseIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
    <path d="m8 9 3 3-3 3" />
  </Icon>
);

export const TextCursorInputIcon = ({ size = 22 }) => (
  <Icon size={size}>
    <path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1" />
    <path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5" />
    <path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1" />
    <path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7" />
    <path d="M9 7v10" />
  </Icon>
);
