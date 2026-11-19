import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { markPlayGuideSeen } from "../api";
import { HeadphonesIcon, LeafIcon, NextSentenceIcon, ReplayIcon } from "../icons";
import "./guide.css";

/**
 * The first-play guide (F2, AC-GUIDE-02): how to 标记, 重听 and go to the next Sentence, shown once before the
 * user's first play. The 专注页 shows it on its own; the settings page (F15, #18) reopens it with `show()`.
 */
export interface PlayGuide {
  /** Whether the user saw the guide already; until then the 专注页 shows it before playing. */
  seen: boolean;
  /** Whether the guide is on screen; the player's shortcuts stay off meanwhile. */
  showing: boolean;
  /** Shows the guide. 【开始听】 closes it, records it seen (the first time) and calls `onStart`. */
  show(onStart?: () => void): void;
  /** Closes the guide without recording anything (the page that showed it went away). */
  hide(): void;
}

const PlayGuideContext = createContext<PlayGuide | null>(null);

export function usePlayGuide(): PlayGuide {
  const guide = useContext(PlayGuideContext);
  if (!guide) throw new Error("usePlayGuide needs a PlayGuideProvider");
  return guide;
}

/** Holds whether the logged-in user saw the guide (`seen`, from /api/me) and shows the guide over the whole app. */
export function PlayGuideProvider({ seen: seenAtStart, children }: { seen: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(seenAtStart);
  const [open, setOpen] = useState<{ onStart?: () => void } | null>(null);
  const show = useCallback((onStart?: () => void) => setOpen({ onStart }), []);
  const hide = useCallback(() => setOpen(null), []);

  const start = () => {
    setOpen(null);
    if (!seen) {
      setSeen(true);
      markPlayGuideSeen().catch((err: unknown) => {
        // Not recorded: it shows once more on the next first play, which is harmless.
        console.warn("recording the play guide as seen failed", err);
      });
    }
    open?.onStart?.();
  };

  const value = useMemo(() => ({ seen, showing: open !== null, show, hide }), [seen, open, show, hide]);
  return (
    <PlayGuideContext.Provider value={value}>
      {children}
      {open && <PlayGuideDialog onStart={start} />}
    </PlayGuideContext.Provider>
  );
}

/** One control the guide explains: its icon, what it does and its key. */
function Gesture({
  icon,
  title,
  text,
  keyLabel,
  highlighted = false,
}: {
  icon: ReactNode;
  title: string;
  text?: string;
  keyLabel?: string;
  highlighted?: boolean;
}) {
  return (
    <li className="guide-gesture">
      <span className={highlighted ? "guide-icon is-highlighted" : "guide-icon"} aria-hidden="true">
        {icon}
      </span>
      <span className="guide-text">
        <span className="guide-title">{title}</span>
        {text && <span className="guide-desc">{text}</span>}
      </span>
      {keyLabel && (
        <kbd className="guide-key" aria-label={`快捷键 ${keyLabel}`}>
          {keyLabel}
        </kbd>
      )}
    </li>
  );
}

/**
 * The guide's dialog (design 01 首次播放引导, with PRD V1.6 over the design: a frosted backdrop, 标记 first and
 * highlighted, 重听 replays the Sentence). Centred on the whole page; only 【开始听】 closes it.
 */
function PlayGuideDialog({ onStart }: { onStart(): void }) {
  const startButton = useRef<HTMLButtonElement>(null);
  useEffect(() => startButton.current?.focus(), []);
  return (
    <div className="guide-backdrop">
      <div className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="play-guide-title">
        <h2 id="play-guide-title" className="guide-heading">
          没听懂？按一下
        </h2>
        <ul className="guide-gestures">
          <Gesture icon={<LeafIcon />} title="标记" text="没听懂就按，句子会留到拾起" keyLabel="M" highlighted />
          <Gesture icon={<ReplayIcon size={26} />} title="重听" text="回到这句开头再听一遍" keyLabel="←" />
          <Gesture icon={<NextSentenceIcon size={26} />} title="下一句" keyLabel="→" />
          <Gesture icon={<HeadphonesIcon size={26} />} title="耳机" text="按两下 下一句 · 按三下 重听（因设备而异）" />
        </ul>
        <button ref={startButton} type="button" className="guide-start" onClick={onStart}>
          开始听
        </button>
      </div>
    </div>
  );
}
