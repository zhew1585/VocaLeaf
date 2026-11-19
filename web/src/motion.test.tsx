import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_MS, motionAllowed, useCollapse, usePresence, usePresenceList } from "./motion";

/** A browser where motion is allowed, or where the user asked for reduced motion. */
function stubMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduced && query.includes("reduce"), media: query })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("motionAllowed", () => {
  it("is off without matchMedia (jsdom) and for reduced motion, on otherwise", () => {
    expect(motionAllowed()).toBe(false);
    stubMotion(true);
    expect(motionAllowed()).toBe(false);
    stubMotion(false);
    expect(motionAllowed()).toBe(true);
  });
});

describe("usePresence", () => {
  beforeEach(() => vi.useFakeTimers());

  it("keeps the last value for the exit, marked exiting, then lets it go", () => {
    stubMotion(false);
    const { result, rerender } = renderHook(({ v }: { v: string | null }) => usePresence(v), { initialProps: { v: "a" as string | null } });
    expect(result.current).toEqual({ value: "a", exiting: false });

    rerender({ v: null });
    expect(result.current).toEqual({ value: "a", exiting: true });

    act(() => vi.advanceTimersByTime(EXIT_MS - 1));
    expect(result.current.value).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual({ value: null, exiting: false });
  });

  it("takes a value that comes back mid-exit as shown again, with no exit afterwards", () => {
    stubMotion(false);
    const { result, rerender } = renderHook(({ v }: { v: boolean }) => usePresence(v), { initialProps: { v: true } });
    rerender({ v: false });
    expect(result.current.exiting).toBe(true);
    rerender({ v: true });
    expect(result.current).toEqual({ value: true, exiting: false });
    act(() => vi.advanceTimersByTime(EXIT_MS * 2));
    expect(result.current).toEqual({ value: true, exiting: false });
  });

  it("shows the newest value while present, not the first", () => {
    stubMotion(false);
    const { result, rerender } = renderHook(({ v }: { v: number | null }) => usePresence(v), { initialProps: { v: 1 as number | null } });
    rerender({ v: 2 });
    rerender({ v: null });
    expect(result.current).toEqual({ value: 2, exiting: true });
  });

  it("drops the value at once for reduced motion, and in tests", () => {
    stubMotion(true);
    const reduced = renderHook(({ v }: { v: boolean }) => usePresence(v), { initialProps: { v: true } });
    reduced.rerender({ v: false });
    expect(reduced.result.current).toEqual({ value: null, exiting: false });

    vi.unstubAllGlobals();
    const plain = renderHook(({ v }: { v: boolean }) => usePresence(v), { initialProps: { v: true } });
    plain.rerender({ v: false });
    expect(plain.result.current).toEqual({ value: null, exiting: false });
  });

  it("takes the exit length it is given", () => {
    stubMotion(false);
    const { result, rerender } = renderHook(({ v }: { v: boolean }) => usePresence(v, 400), { initialProps: { v: true } });
    rerender({ v: false });
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(result.current.exiting).toBe(true);
    act(() => vi.advanceTimersByTime(400 - EXIT_MS));
    expect(result.current.value).toBe(null);
  });
});

describe("usePresenceList", () => {
  beforeEach(() => vi.useFakeTimers());
  const key = (s: string) => s;
  const keys = (entries: { item: string; exiting: boolean }[]) => entries.map((e) => (e.exiting ? `-${e.item}` : e.item));

  it("keeps removed items in their place while they leave, then drops them", () => {
    stubMotion(false);
    const { result, rerender } = renderHook(({ items }: { items: string[] }) => usePresenceList(items, key), {
      initialProps: { items: ["a", "b", "c", "d"] },
    });
    rerender({ items: ["b", "d"] });
    expect(keys(result.current)).toEqual(["-a", "b", "-c", "d"]);

    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(keys(result.current)).toEqual(["b", "d"]);
  });

  it("adds new items at once and keeps a leaving one through further changes", () => {
    stubMotion(false);
    const { result, rerender } = renderHook(({ items }: { items: string[] }) => usePresenceList(items, key), {
      initialProps: { items: ["a", "b"] },
    });
    rerender({ items: ["b"] });
    rerender({ items: ["n", "b"] });
    expect(keys(result.current)).toEqual(["-a", "n", "b"]);
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(keys(result.current)).toEqual(["n", "b"]);
  });

  it("follows the list at once without motion", () => {
    const { result, rerender } = renderHook(({ items }: { items: string[] }) => usePresenceList(items, key), {
      initialProps: { items: ["a", "b"] },
    });
    rerender({ items: ["b"] });
    expect(keys(result.current)).toEqual(["b"]);
  });
});

describe("useCollapse", () => {
  it("fixes the element's height in pixels once it starts leaving", () => {
    function Item({ exiting }: { exiting: boolean }) {
      const ref = useCollapse<HTMLDivElement>(exiting);
      return <div ref={ref} data-testid="item" />;
    }
    const { rerender } = render(<Item exiting={false} />);
    const el = screen.getByTestId("item");
    Object.defineProperty(el, "offsetHeight", { value: 84 });
    expect(el.style.height).toBe("");
    rerender(<Item exiting />);
    expect(el.style.height).toBe("84px");
  });
});
