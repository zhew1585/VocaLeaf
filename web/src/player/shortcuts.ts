import { useEffect, useRef } from "react";
import type { Rating } from "../api";

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
  /** Esc: closes the topmost layer; on the 专注页 that deselects the selected Sentence (PRD 4.4.1). */
  escape?(): void;
}

/** Where keys are typing (追问, 搜索, 验证码 and any other field): every shortcut is off there (AC-PLAY-18). */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TYPING) !== null;
}

/** What one key does with a page's handlers (nothing when the handler is missing), and whether holding it repeats it. */
interface Binding<H> {
  run(handlers: H): (() => void) | undefined;
  repeats: boolean;
}

/** The 专注页's keys; moving by Sentence repeats while held. */
const PLAYER_KEYS: Record<string, Binding<ShortcutHandlers>> = {
  " ": { run: (h) => h.toggle, repeats: false },
  ArrowLeft: { run: (h) => h.replay, repeats: true },
  ArrowRight: { run: (h) => h.next, repeats: true },
  m: { run: (h) => h.mark, repeats: false },
  M: { run: (h) => h.mark, repeats: false },
  Escape: { run: (h) => h.escape, repeats: false },
};

/** The keys above as the settings page lists them (design 08-1); Esc only closes layers, so it is not listed. */
export const PLAYER_SHORTCUTS = [
  { name: "播放 / 暂停", keys: ["空格"] },
  { name: "重听", keys: ["←"] },
  { name: "下一句", keys: ["→"] },
  { name: "标记", keys: ["M"] },
] as const;

/** What the 复习页's keys do (PRD F13 桌面快捷键). */
export interface ReviewShortcutHandlers {
  /** Space: 【显示答案】. */
  reveal?(): void;
  /** 1 to 4: 忘了, 困难, 记得, 简单. */
  rate?(rating: Rating): void;
}

const rateKey = (rating: Rating): Binding<ReviewShortcutHandlers> => ({
  run: ({ rate }) => rate && (() => rate(rating)),
  repeats: false,
});

const REVIEW_KEYS: Record<string, Binding<ReviewShortcutHandlers>> = {
  " ": { run: (h) => h.reveal, repeats: false },
  "1": rateKey(1),
  "2": rateKey(2),
  "3": rateKey(3),
  "4": rateKey(4),
};

/** The 复习页's keys as the settings page lists them (design 08-1). */
export const REVIEW_SHORTCUTS = [
  { name: "显示答案", keys: ["空格"] },
  { name: "评分", keys: ["1", "2", "3", "4"] },
] as const;

/**
 * Desktop keys of the 专注页 while it is mounted: Space, ←, →, M and Esc. Keys held with a modifier, or typed into a
 * field, are left alone, and so is every key while `handlers` is null (the page's Book is not the one playing).
 * Listens before the page's own handlers, so Space plays or pauses instead of scrolling the text or pressing the
 * focused button.
 */
export function useShortcuts(handlers: ShortcutHandlers | null) {
  useKeys(PLAYER_KEYS, handlers);
}

/** Desktop keys of the 复习页 while it is mounted: Space and 1 to 4, by the same rules as useShortcuts. */
export function useReviewShortcuts(handlers: ReviewShortcutHandlers | null) {
  useKeys(REVIEW_KEYS, handlers);
}

function useKeys<H>(keys: Record<string, Binding<H>>, handlers: H | null) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const skip = (e: KeyboardEvent) =>
      latest.current === null || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target);
    /** What the key does now, if anything. */
    const handlerOf = (e: KeyboardEvent) => {
      const key = keys[e.key];
      return key && latest.current !== null ? key.run(latest.current) : undefined;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const key = keys[e.key];
      const handler = handlerOf(e);
      if (skip(e) || !key || !handler) return;
      e.preventDefault();
      // Holding Space or M down must not toggle or mark again and again.
      if (e.repeat && !key.repeats) return;
      handler();
    };
    // A focused button presses itself on Space's keyup; the keydown already did what Space does. Where Space does
    // nothing (复习's back), the button presses as usual.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && !skip(e) && handlerOf(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [keys]);
}
