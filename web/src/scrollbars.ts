/**
 * Overlay-style scrollbars on classic ones: a scroll area's thumb shows while the user scrolls it, or while the
 * pointer is on its scrollbar, and fades out from SCROLLBAR_IDLE_MS after. The scrollbar itself always keeps its
 * gutter and stays grabbable; only its colour changes, from the SCROLLBAR_ATTR rules in styles.css.
 *
 * Scrolls the app makes on its own (following playback, a streamed reply, keeping the reading place when a click
 * narrows the column) do not show it: only a scroll within INPUT_WINDOW_MS of the user's wheel, finger drag,
 * scrolling key or middle-button press does. Dragging the bar itself shows it from the pointer.
 */

/** Set on a scroll area while its scrollbar shows; the page's own scrollbar takes its style from the body. */
export const SCROLLBAR_ATTR = "data-scrollbar";
/** How long a scrollbar stays after the last scroll or after the pointer leaves it, before it fades out. */
export const SCROLLBAR_IDLE_MS = 700;
/** How soon after the user's input a scroll still counts as theirs. */
export const INPUT_WINDOW_MS = 400;

/** Installs the listeners on the document, once at app start; returns their removal. */
export function autoHideScrollbars(doc: Document = document): () => void {
  const bars = scrollbarStates(doc);
  let lastInput = -Infinity;

  const onInput = (e: Event) => {
    if (isScrollInput(e)) lastInput = Date.now();
  };

  const onScroll = (e: Event) => {
    // The page's own scroll fires on the document.
    if (Date.now() - lastInput <= INPUT_WINDOW_MS) bars.show(e.target instanceof Element ? e.target : doc.documentElement);
  };

  const onMouseMove = (e: Event) => {
    const target = e.target instanceof Element ? e.target : null;
    bars.hover(target && e instanceof MouseEvent && onScrollbar(target, e) ? target : null);
  };

  // Leaving the window (relatedTarget null) leaves any scrollbar too; the page's own sits at the window's edge.
  const onMouseOut = (e: Event) => {
    if (e instanceof MouseEvent && !e.relatedTarget) bars.hover(null);
  };

  const listeners: [string, (e: Event) => void][] = [
    ["wheel", onInput],
    ["touchmove", onInput],
    ["keydown", onInput],
    ["mousedown", onInput],
    ["scroll", onScroll],
    ["mousemove", onMouseMove],
    ["mouseout", onMouseOut],
  ];
  const options = { capture: true, passive: true } as const;
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, options);
  return () => {
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener, options);
    bars.clear();
  };
}

/** Which scrollbars show: each until SCROLLBAR_IDLE_MS after it was last shown, the hovered one for as long as it is. */
function scrollbarStates(doc: Document) {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  // The scrollbar the pointer is on, by the element it is styled from.
  let hovered: Element | null = null;

  // The page's scrollbar is styled from the body (Chrome's choice when the body has scrollbar rules).
  const styled = (area: Element) => (area === doc.documentElement ? doc.body : area);

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

  const show = (area: Element) => {
    const el = styled(area);
    el.setAttribute(SCROLLBAR_ATTR, "");
    if (el === hovered) clearTimeout(timers.get(el));
    else hideLater(el);
  };

  const hover = (area: Element | null) => {
    const el = area && styled(area);
    if (el === hovered) return;
    const left = hovered;
    hovered = el;
    if (left) hideLater(left);
    if (el) show(el);
  };

  const clear = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    hovered = null;
    for (const el of doc.querySelectorAll(`[${SCROLLBAR_ATTR}]`)) el.removeAttribute(SCROLLBAR_ATTR);
  };

  return { show, hover, clear };
}

/**
 * Whether an input event is the user starting to scroll: a wheel, a finger drag, a key outside a text field, or a
 * middle-button press (autoscroll). A click is not, nor is typing, though the app may scroll after either.
 */
function isScrollInput(e: Event): boolean {
  if (e instanceof KeyboardEvent) {
    return !(e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]"));
  }
  if (e.type === "mousedown") return e instanceof MouseEvent && e.button === 1;
  return true;
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
