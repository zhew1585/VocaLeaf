import { useEffect, useRef } from "react";

/** What the 专注页's keys do (PRD 4.4.1 桌面快捷键). */
export interface ShortcutHandlers {
  /** Space. */
  toggle(): void;
  /** ←, by the 重听 rule. */
  replay(): void;
  /** →. */
  next(): void;
  /** M: 【标记】 (PRD 4.4.2). */
  mark?(): void;
}

/** Where keys are typing (追问, 搜索, 验证码 and any other field): every shortcut is off there (AC-PLAY-18). */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TYPING) !== null;
}

type Action = keyof ShortcutHandlers;

/** Which action each key triggers, and whether holding it down repeats it (moving by Sentence does). */
const KEYS: Record<string, { action: Action; repeats: boolean }> = {
  " ": { action: "toggle", repeats: false },
  ArrowLeft: { action: "replay", repeats: true },
  ArrowRight: { action: "next", repeats: true },
  m: { action: "mark", repeats: false },
  M: { action: "mark", repeats: false },
};

/**
 * Desktop keys of the 专注页 while it is mounted: Space, ←, → and M. Keys held with a modifier, or typed into a
 * field, are left alone, and so is every key while `handlers` is null (the page's Book is not the one playing).
 * Listens before the page's own handlers, so Space plays or pauses instead of scrolling the text or pressing the
 * focused button.
 */
export function useShortcuts(handlers: ShortcutHandlers | null) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const skip = (e: KeyboardEvent) =>
      latest.current === null || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target);
    const onKeyDown = (e: KeyboardEvent) => {
      const key = KEYS[e.key];
      const handler = key && latest.current?.[key.action];
      if (skip(e) || !key || !handler) return;
      e.preventDefault();
      // Holding Space or M down must not toggle or mark again and again.
      if (e.repeat && !key.repeats) return;
      handler();
    };
    // A focused button presses itself on Space's keyup; the keydown already played or paused.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && !skip(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, []);
}
