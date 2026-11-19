import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReviewShortcuts, useShortcuts, type ReviewShortcutHandlers, type ShortcutHandlers } from "./shortcuts";

afterEach(cleanup);

function setUp() {
  const handlers = { toggle: vi.fn(), replay: vi.fn(), next: vi.fn(), mark: vi.fn() } satisfies ShortcutHandlers;
  function Page() {
    useShortcuts(handlers);
    return (
      <>
        <button type="button">倍速</button>
        <input aria-label="追问这一句" />
        <textarea aria-label="笔记" />
      </>
    );
  }
  const view = render(<Page />);
  return { handlers, view };
}

describe("desktop shortcuts (PRD 4.4.1)", () => {
  it("sends Space, ←, → and M to play / pause, 重听, 下一句 and Mark", () => {
    const { handlers } = setUp();
    fireEvent.keyDown(document.body, { key: " " });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "m" });
    fireEvent.keyDown(document.body, { key: "M" });
    expect([handlers.toggle, handlers.replay, handlers.next, handlers.mark].map((f) => f.mock.calls.length)).toEqual([
      1, 1, 1, 2,
    ]);
  });

  it("takes Space from a focused button, so it plays or pauses instead of pressing the button", () => {
    const { handlers, view } = setUp();
    const button = view.getByRole("button");
    button.focus();
    const down = fireEvent.keyDown(button, { key: " " });
    const up = fireEvent.keyUp(button, { key: " " });
    expect(handlers.toggle).toHaveBeenCalledTimes(1);
    // fireEvent returns false once the default action was prevented.
    expect([down, up]).toEqual([false, false]);
  });

  it("is off while typing in a field (AC-PLAY-18)", () => {
    const { handlers, view } = setUp();
    for (const field of [view.getByLabelText("追问这一句"), view.getByLabelText("笔记")]) {
      expect(fireEvent.keyDown(field, { key: "m" })).toBe(true);
      expect(fireEvent.keyDown(field, { key: " " })).toBe(true);
      fireEvent.keyDown(field, { key: "ArrowLeft" });
    }
    expect([handlers.toggle, handlers.replay, handlers.mark].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("leaves keys held with a modifier, other keys, and a held-down Space alone", () => {
    const { handlers } = setUp();
    fireEvent.keyDown(document.body, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(document.body, { key: "m", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: " ", repeat: true });
    expect([handlers.toggle, handlers.replay, handlers.mark].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("leaves every key alone while the page's Book is not the one playing", () => {
    function Page() {
      useShortcuts(null);
      return null;
    }
    render(<Page />);
    expect(fireEvent.keyDown(document.body, { key: " " })).toBe(true);
  });

  it("stops listening when the page goes away", () => {
    const { handlers, view } = setUp();
    view.unmount();
    fireEvent.keyDown(document.body, { key: " " });
    expect(handlers.toggle).not.toHaveBeenCalled();
  });
});

describe("复习 shortcuts (PRD F13)", () => {
  function setUpReview(handlers: ReviewShortcutHandlers) {
    function Page() {
      useReviewShortcuts(handlers);
      return <input aria-label="搜索" />;
    }
    return render(<Page />);
  }

  it("sends Space to 显示答案 and 1 to 4 to the ratings, the same keys a held-down one does not repeat", () => {
    const reveal = vi.fn();
    const rate = vi.fn();
    setUpReview({ reveal, rate });
    fireEvent.keyDown(document.body, { key: " " });
    for (const key of ["1", "2", "3", "4", "5"]) fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: "3", repeat: true });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(rate.mock.calls).toEqual([[1], [2], [3], [4]]);
  });

  it("leaves keys alone without their handler, while typing, and with a modifier", () => {
    const rate = vi.fn();
    const view = setUpReview({ rate });
    expect(fireEvent.keyDown(document.body, { key: " " })).toBe(true);
    fireEvent.keyDown(view.getByLabelText("搜索"), { key: "1" });
    fireEvent.keyDown(document.body, { key: "2", metaKey: true });
    expect(rate).not.toHaveBeenCalled();
  });
});
