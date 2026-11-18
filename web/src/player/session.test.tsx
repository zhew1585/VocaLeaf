import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audio, hlsInstances, stubMediaPlayback } from "../test-media";
import { ListeningProvider, useListening, type Listening } from "./session";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

let media: ReturnType<typeof stubMediaPlayback>;
beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Renders the provider and hands back the live session. */
function session() {
  const ref: { current: Listening | null } = { current: null };
  function Probe() {
    ref.current = useListening();
    return null;
  }
  render(
    <ListeningProvider>
      <Probe />
    </ListeningProvider>,
  );
  return () => ref.current!;
}

describe("the listening session", () => {
  it("loads nothing until a Book is opened, then that Book's playlist, once", () => {
    const s = session();
    expect(hlsInstances).toHaveLength(0);

    act(() => s().open("b1"));
    act(() => s().open("b1"));

    expect(hlsInstances.map((h) => h.source)).toEqual(["/api/books/b1/audio.m3u8"]);
    expect(s().bookId).toBe("b1");
  });

  it("switches to another Book: the first stops and the second starts paused at its beginning", () => {
    const s = session();
    act(() => s().open("b1"));
    act(() => s().toggle());
    expect(s().playing).toBe(true);

    act(() => s().open("b2"));

    expect(s()).toMatchObject({ bookId: "b2", playing: false, position: 0 });
    expect(hlsInstances.map((h) => [h.source, h.destroyed])).toEqual([
      ["/api/books/b1/audio.m3u8", true],
      ["/api/books/b2/audio.m3u8", false],
    ]);
  });

  it("plays from a position, even when paused before", () => {
    const s = session();
    act(() => s().open("b1"));

    act(() => s().playFrom(8));

    expect(audio().currentTime).toBe(8);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(s()).toMatchObject({ playing: true, position: 8 });
  });
});
