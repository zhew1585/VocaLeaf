import { useRef, useState, type PointerEvent } from "react";

/** "1:02:05": hours, minutes, seconds of the whole Book (it runs for hours). */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "−11:31:40", with a true minus sign as in the design. */
export function formatRemaining(seconds: number): string {
  return `−${formatElapsed(seconds)}`;
}

interface Props {
  position: number;
  length: number;
  /** Called once on release with the position dragged to (PRD 4.4.1 进度拖动). */
  onSeek(seconds: number): void;
}

/**
 * The whole Book's progress bar with time listened and time left. Pressing or dragging it moves the knob and
 * the times with the pointer; releasing seeks there.
 */
export function Progress({ position, length, onSeek }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const shown = Math.min(dragged ?? position, length);
  const share = length > 0 ? Math.min(Math.max(shown / length, 0), 1) : 0;

  const at = (e: PointerEvent) => {
    const box = track.current!.getBoundingClientRect();
    return box.width > 0 ? Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1) * length : 0;
  };

  return (
    <div className="player-progress">
      <span className="player-time">{formatElapsed(shown)}</span>
      <div
        ref={track}
        className={dragged === null ? "player-track" : "player-track dragging"}
        role="slider"
        aria-label="整本进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={formatElapsed(shown)}
        onPointerDown={(e) => {
          if (length <= 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDragged(at(e));
        }}
        onPointerMove={(e) => dragged !== null && setDragged(at(e))}
        onPointerUp={(e) => {
          if (dragged === null) return;
          setDragged(null);
          onSeek(at(e));
        }}
        onPointerCancel={() => setDragged(null)}
      >
        <div className="player-fill" style={{ width: `${share * 100}%` }} />
        <div className="player-knob" style={{ left: `${share * 100}%` }} />
      </div>
      <span className="player-time">{formatRemaining(length - shown)}</span>
    </div>
  );
}
