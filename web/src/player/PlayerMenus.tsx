import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, MoonIcon } from "../icons";
import { SLEEP_MINUTES, type SleepChoice } from "./sleep";
import { SPEEDS, speedLabel } from "./speed";
import { useListening } from "./session";

/**
 * A button with a menu that opens above it (design 01 ④). The menu closes on a pick, on Esc and on a press
 * outside it.
 */
function MenuButton({
  label,
  buttonClass,
  button,
  children,
}: {
  label: string;
  buttonClass: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="player-menu">
      <button
        type="button"
        className={buttonClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open && (
        <div className="player-popover" role="menu" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One choice in a menu, checked when it is the current one. */
function MenuOption({ label, checked, onPick }: { label: string; checked: boolean; onPick(): void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={checked ? "player-option checked" : "player-option"}
      onClick={onPick}
    >
      {label}
      {checked && <CheckIcon size={16} />}
    </button>
  );
}

/** 倍速 (PRD 4.4.1): the seven speeds; the choice holds for every Book. */
export function SpeedMenu() {
  const { speed, setSpeed } = useListening();
  return (
    <MenuButton label={`倍速 ${speedLabel(speed)}`} buttonClass="player-speed" button={speedLabel(speed)}>
      {(close) => (
        <>
          <p className="player-popover-title">倍速</p>
          {SPEEDS.map((s) => (
            <MenuOption
              key={s}
              label={speedLabel(s)}
              checked={s === speed}
              onPick={() => {
                setSpeed(s);
                close();
              }}
            />
          ))}
        </>
      )}
    </MenuButton>
  );
}

/** "24:10": minutes and seconds left, rounded up. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The menu's header: 睡眠定时 and the time left on a running timer, counting down while open. */
function SleepHeader() {
  const { sleep, sleepRemaining } = useListening();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (sleep === null) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [sleep]);
  const left = sleep === null ? null : sleepRemaining();
  return (
    <div className="player-popover-header">
      <span>睡眠定时</span>
      {left !== null && <span className="player-countdown">{formatCountdown(left)}</span>}
    </div>
  );
}

/** 睡眠定时 (PRD 4.4.1, F7): 15 to 60 minutes or 【本章结束】; open again for the time left and 【关闭定时】. */
export function SleepMenu() {
  const { sleep, setSleep } = useListening();
  const options: { choice: SleepChoice; label: string }[] = [
    ...SLEEP_MINUTES.map((m) => ({ choice: m, label: `${m} 分钟` })),
    { choice: "chapter", label: "本章结束" },
  ];
  return (
    <MenuButton
      label="睡眠定时"
      buttonClass={sleep === null ? "player-icon-button" : "player-icon-button active"}
      button={<MoonIcon />}
    >
      {(close) => (
        <>
          <SleepHeader />
          {options.map(({ choice, label }) => (
            <MenuOption
              key={choice}
              label={label}
              checked={sleep?.choice === choice}
              onPick={() => {
                setSleep(choice);
                close();
              }}
            />
          ))}
          {sleep !== null && (
            <>
              <hr className="player-popover-divider" />
              <button
                type="button"
                role="menuitem"
                className="player-option quiet"
                onClick={() => {
                  setSleep(null);
                  close();
                }}
              >
                关闭定时
              </button>
            </>
          )}
        </>
      )}
    </MenuButton>
  );
}
