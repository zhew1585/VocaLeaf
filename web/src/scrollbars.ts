/**
 * Overlay-style scrollbars on classic ones: a scroll area's thumb shows while the user scrolls it, or while the
 * pointer is on its scrollbar, and fades out SCROLLBAR_IDLE_MS after. The scrollbar itself always keeps its gutter
 * and stays grabbable; only its colour changes, from the SCROLLBAR_ATTR rules in styles.css.
 *
 * Scrolls the app makes on its own (following playback, a streamed reply, keeping the reading place when a click
 * narrows the column) do not show it: only a scroll within INPUT_WINDOW_MS of the user's wheel, finger drag, key or
 * middle-button press does, or one on a bar already showing. Dragging the bar itself shows it from the pointer.
 */

/** Set on a scroll area while its scrollbar shows; the page's own scrollbar takes its style from the body. */
export const SCROLLBAR_ATTR = "data-scrollbar";
/** How long a scrollbar stays after the last scroll or after the pointer leaves it. */
export const SCROLLBAR_IDLE_MS = 1000;
/** How soon after the user's input a scroll still counts as theirs. */
export const INPUT_WINDOW_MS = 400;

const INPUT_EVENTS = ["wheel", "touchmove", "keydown", "mousedown"] as const;

/** Installs the listeners on the document, once at app start; returns their removal. */
export function autoHideScrollbars(doc: Document = document): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  let lastInput = -Infinity;
  // The scroll area whose scrollbar the pointer is on.
  let hovered: Element | null = null;

  // The page's scrollbar is styled from the body (Chrome's choice when the body has scrollbar rules).
  const styled = (el: Element) => (el === doc.documentElement ? doc.body : el);

  const hideLater = (el: Element) => {
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el);
        el.removeAttribute(SCROLLBAR_ATTR);
      }, SCROLLBAR_IDLE_MS),
    );
  };

  const show = (el: Element) => {
    el.setAttribute(SCROLLBAR_ATTR, "");
    if (el === hovered) clearTimeout(timers.get(el));
    else hideLater(el);
  };

  // A click is not a scroll; a middle-button press starts autoscroll.
  const onInput = (e: Event) => {
    if (e.type === "mousedown" && (e as MouseEvent).button !== 1) return;
    lastInput = Date.now();
  };

  const onScroll = (e: Event) => {
    // The page's own scroll fires on the document.
    const el = styled(e.target instanceof Element ? e.target : doc.documentElement);
    if (Date.now() - lastInput <= INPUT_WINDOW_MS || el.hasAttribute(SCROLLBAR_ATTR)) show(el);
  };

  const hover = (el: Element | null) => {
    if (el === hovered) return;
    const left = hovered;
    hovered = el;
    if (left) hideLater(left);
    if (el) show(el);
  };

  const onMouseMove = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    hover(target && onScrollbar(target, e) ? styled(target) : null);
  };

  // Leaving the window (relatedTarget null) leaves any scrollbar too; the page's own sits at the window's edge.
  const onMouseOut = (e: MouseEvent) => {
    if (!e.relatedTarget) hover(null);
  };

  const options = { capture: true, passive: true } as const;
  for (const type of INPUT_EVENTS) doc.addEventListener(type, onInput, options);
  doc.addEventListener("scroll", onScroll, options);
  doc.addEventListener("mousemove", onMouseMove, options);
  doc.addEventListener("mouseout", onMouseOut, options);
  return () => {
    for (const type of INPUT_EVENTS) doc.removeEventListener(type, onInput, options);
    doc.removeEventListener("scroll", onScroll, options);
    doc.removeEventListener("mousemove", onMouseMove, options);
    doc.removeEventListener("mouseout", onMouseOut, options);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

/**
 * Whether the pointer is on the element's own scrollbar: past its content box (as ReadingView tells a press on it)
 * on an axis that scrolls.
 */
function onScrollbar(el: Element, e: MouseEvent): boolean {
  return (
    (e.offsetX >= el.clientWidth && el.scrollHeight > el.clientHeight) ||
    (e.offsetY >= el.clientHeight && el.scrollWidth > el.clientWidth)
  );
}
