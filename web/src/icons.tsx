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

export const PlusIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Icon>
);

export const XIcon = ({ size = 22 }) => (
  <Icon size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const CheckIcon = ({ size = 14 }) => (
  <Icon size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const HeadphonesIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
  </Icon>
);

export const FileXIcon = ({ size = 30 }) => (
  <Icon size={size}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="m14.5 12.5-5 5" />
    <path d="m9.5 12.5 5 5" />
  </Icon>
);

export const LibraryIcon = ({ size = 20 }) => (
  <Icon size={size}>
    <path d="m16 6 4 14" />
    <path d="M12 6v14" />
    <path d="M8 8v12" />
    <path d="M4 4v16" />
  </Icon>
);

export const TrashIcon = ({ size = 15 }) => (
  <Icon size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </Icon>
);

/** The design's "1" inside the 重听 / 下一句 arrows (VocalLeaf V1.0.0.pen, 数字 1). */
const ONE = "M9.5 10.1l2.5-1.9h1.6v8h-1.75v-5.95l-1.5 1.15z";

/** 重听: Lucide rotate-ccw with a 1 in its middle. */
export const ReplayIcon = ({ size = 22 }) => (
  <Icon size={size}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d={ONE} fill="currentColor" stroke="none" />
  </Icon>
);

/** 下一句: Lucide rotate-cw with a 1 in its middle. */
export const NextSentenceIcon = ({ size = 22 }) => (
  <Icon size={size}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d={ONE} fill="currentColor" stroke="none" />
  </Icon>
);

/** 睡眠定时: Lucide moon. */
export const MoonIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Icon>
);

/** 标记 and the 拾起 navigation: Lucide leaf. */
export const LeafIcon = ({ size = 17 }) => (
  <Icon size={size}>
    <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
    <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
  </Icon>
);

/** 定位原文: Lucide locate. */
export const LocateIcon = ({ size = 18 }) => (
  <Icon size={size}>
    <line x1="2" x2="5" y1="12" y2="12" />
    <line x1="19" x2="22" y1="12" y2="12" />
    <line x1="12" x2="12" y1="2" y2="5" />
    <line x1="12" x2="12" y1="19" y2="22" />
    <circle cx="12" cy="12" r="7" />
  </Icon>
);
