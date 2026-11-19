// Motion helpers. Entering is plain CSS (an animation on mount, the keyframes and tokens in styles.css); leaving needs
// the element kept on screen while it animates out, which these hooks do. Exits are short and never in the way:
// an element leaving takes no pointer events (.is-exiting), and coming back mid-exit just keeps it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How long a popover, toast, dialog or list item takes to leave; --motion-exit in styles.css, plus a frame. */
export const EXIT_MS = 160;
/** How long a side panel takes to slide away; --motion-exit-panel in styles.css, plus a frame. */
export const PANEL_EXIT_MS = 220;

/**
 * Whether exits animate: not for users who ask for reduced motion, nor where nothing animates at all (jsdom, which
 * has no matchMedia), so tests see elements go at once.
 */
export function motionAllowed(): boolean {
  return typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Absent = null | undefined | false;

function isPresent<T>(value: T | Absent): value is T {
  return value !== null && value !== undefined && value !== false;
}

export interface Presence<T> {
  /** What to render: the value while there is one, the last one while it animates out, then null. */
  value: T | null;
  /** The value is gone and the element is on its way out: render it with .is-exiting. */
  exiting: boolean;
}

/**
 * Keeps something on screen for its exit animation after it goes. `value` is what is shown (a flag, the item a
 * dialog is about, …); null, undefined or false means nothing is. Render from the returned value, with .is-exiting
 * while `exiting`:
 *
 *   const menu = usePresence(open);
 *   {menu.value && <div className={menu.exiting ? "popover is-exiting" : "popover"} />}
 */
export function usePresence<T>(value: T | Absent, exitMs = EXIT_MS): Presence<T> {
  const present = isPresent(value);
  const last = useRef<T | null>(present ? value : null);
  if (present) last.current = value;
  const [wasPresent, setWasPresent] = useState(present);
  const [exiting, setExiting] = useState(false);
  // Adjusted while rendering, so the frame where the value goes already shows it leaving.
  if (present !== wasPresent) {
    setWasPresent(present);
    setExiting(!present && exitMs > 0 && motionAllowed());
  }
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setExiting(false), exitMs);
    return () => clearTimeout(timer);
  }, [exiting, exitMs]);

  if (present) return { value, exiting: false };
  return exiting ? { value: last.current, exiting: true } : { value: null, exiting: false };
}

export interface ListEntry<T> {
  item: T;
  /** Gone from the list, still shown while it collapses away. */
  exiting: boolean;
}

/**
 * A list whose removed items stay where they were for their exit animation (collapse, see useCollapse) before
 * they go. Items that come in are new elements, which their CSS fades in.
 */
export function usePresenceList<T>(items: readonly T[], keyOf: (item: T) => string, exitMs = EXIT_MS): ListEntry<T>[] {
  const [shown, setShown] = useState<{ items: readonly T[]; entries: ListEntry<T>[] }>(() => ({
    items,
    entries: items.map((item) => ({ item, exiting: false })),
  }));
  let entries = shown.entries;
  if (shown.items !== items) {
    entries = merge(shown.entries, items, keyOf, exitMs > 0 && motionAllowed());
    setShown({ items, entries });
  }
  const anyExiting = entries.some((e) => e.exiting);
  useEffect(() => {
    if (!anyExiting) return;
    const timer = setTimeout(
      () => setShown((s) => ({ items: s.items, entries: s.entries.filter((e) => !e.exiting) })),
      exitMs,
    );
    return () => clearTimeout(timer);
  }, [anyExiting, exitMs, shown]);
  return entries;
}

/** The new items in order, each removed one (when kept) right after the item it followed. */
function merge<T>(before: ListEntry<T>[], items: readonly T[], keyOf: (item: T) => string, keep: boolean): ListEntry<T>[] {
  const next = items.map((item) => ({ item, exiting: false }));
  if (!keep) return next;
  const now = new Set(items.map(keyOf));
  // Removed items by the key of the closest earlier item still there ("" for the list's start).
  const after = new Map<string, ListEntry<T>[]>();
  let anchor = "";
  for (const entry of before) {
    const key = keyOf(entry.item);
    if (now.has(key)) anchor = key;
    else after.set(anchor, [...(after.get(anchor) ?? []), { item: entry.item, exiting: true }]);
  }
  if (after.size === 0) return next;
  return [...(after.get("") ?? []), ...next.flatMap((e) => [e, ...(after.get(keyOf(e.item)) ?? [])])];
}

/**
 * For an element that collapses as it leaves (.is-exiting with the collapse-out animation): fixes its height in
 * pixels when it starts leaving, so the animation can take it to 0 (CSS cannot animate from `auto`).
 */
export function useCollapse<E extends HTMLElement>(exiting: boolean) {
  const ref = useRef<E>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (exiting && el) el.style.height = `${el.offsetHeight}px`;
  }, [exiting]);
  return ref;
}
