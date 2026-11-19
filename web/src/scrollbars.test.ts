import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoHideScrollbars, INPUT_WINDOW_MS, SCROLLBAR_ATTR, SCROLLBAR_IDLE_MS } from "./scrollbars";

/** A 200 x 200 scroll area with 2000 px of content and a 10 px scrollbar (jsdom does no layout). */
function scroller(): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperties(el, {
    clientWidth: { value: 190 },
    clientHeight: { value: 200 },
    scrollHeight: { value: 2000 },
    scrollWidth: { value: 190 },
  });
  document.body.append(el);
  return el;
}

const wheel = (el: Element) => el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
const scroll = (el: Element | Document) => el.dispatchEvent(new Event("scroll"));

/** A mouse move at x within the element (offsetX, which jsdom does not compute). */
function move(el: Element, offsetX: number, relatedTarget: Element | null = el) {
  const e = new MouseEvent("mousemove", { bubbles: true, relatedTarget });
  Object.defineProperties(e, { offsetX: { value: offsetX }, offsetY: { value: 10 } });
  el.dispatchEvent(e);
}

const shown = (el: Element) => el.hasAttribute(SCROLLBAR_ATTR);

describe("autoHideScrollbars", () => {
  let uninstall: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    uninstall = autoHideScrollbars(document);
  });
  afterEach(() => {
    uninstall();
    vi.useRealTimers();
    document.body.replaceChildren();
    document.body.removeAttribute(SCROLLBAR_ATTR);
  });

  it("shows a scroll area's bar while the user scrolls it and hides it once scrolling stops", () => {
    const el = scroller();
    wheel(el);
    scroll(el);
    expect(shown(el)).toBe(true);

    // Each scroll keeps it up for another idle period.
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS - 100);
    scroll(el);
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS - 100);
    expect(shown(el)).toBe(true);

    vi.advanceTimersByTime(100);
    expect(shown(el)).toBe(false);
  });

  it("marks the body for the page's own scroll, as Chrome styles the page's bar from it", () => {
    wheel(document.body);
    scroll(document);
    expect(shown(document.body)).toBe(true);
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS);
    expect(shown(document.body)).toBe(false);
  });

  it("does not show the bar for a scroll the app makes on its own", () => {
    const el = scroller();
    scroll(el);
    expect(shown(el)).toBe(false);

    // A click that makes the app scroll (a wider or narrower column keeping its place) is not a scroll.
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    scroll(el);
    expect(shown(el)).toBe(false);

    wheel(el);
    vi.advanceTimersByTime(INPUT_WINDOW_MS + 1);
    scroll(el);
    expect(shown(el)).toBe(false);
  });

  it("counts keys, finger drags and a middle-button press as the user's scroll", () => {
    const el = scroller();
    for (const input of [
      new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" }),
      new Event("touchmove", { bubbles: true }),
      new MouseEvent("mousedown", { bubbles: true, button: 1 }),
    ]) {
      el.dispatchEvent(input);
      scroll(el);
      expect(shown(el)).toBe(true);
      vi.advanceTimersByTime(SCROLLBAR_IDLE_MS);
      expect(shown(el)).toBe(false);
    }
  });

  it("shows the bar while the pointer is on it and hides it after the pointer leaves", () => {
    const el = scroller();
    move(el, 195);
    expect(shown(el)).toBe(true);
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS * 5);
    expect(shown(el)).toBe(true);

    move(el, 100);
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS - 1);
    expect(shown(el)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shown(el)).toBe(false);
  });

  it("hides the bar when the pointer leaves the window from it", () => {
    const el = scroller();
    move(el, 195);
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS);
    expect(shown(el)).toBe(false);
  });

  it("stops listening once removed", () => {
    const el = scroller();
    uninstall();
    wheel(el);
    scroll(el);
    move(el, 195);
    expect(shown(el)).toBe(false);
    uninstall = () => {};
  });
});
