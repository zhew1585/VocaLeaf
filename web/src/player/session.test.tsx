import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audio, audioWithGenerated, grow, hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";
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
  vi.unstubAllGlobals();
});

/** Renders the provider and hands back the live session, and the render result to unmount it. */
function session() {
  const ref: { current: Listening | null } = { current: null };
  function Probe() {
    ref.current = useListening();
    return null;
  }
  const view = render(
    <ListeningProvider>
      <Probe />
    </ListeningProvider>,
  );
  return Object.assign(() => ref.current!, { unmount: view.unmount });
}

describe("the listening session", () => {
  it("loads nothing until a Book is opened, then that Book's playlist from its beginning, once", () => {
    const s = session();
    expect(hlsInstances).toHaveLength(0);

    act(() => s().open("b1"));
    act(() => s().open("b1"));

    expect(hlsInstances.map((h) => h.source)).toEqual(["/api/books/b1/audio.m3u8"]);
    expect(hlsInstances[0]!.media).toBe(audio());
    // An EVENT playlist would otherwise start at its live edge.
    expect(hlsInstances[0]!.config).toMatchObject({ startPosition: 0 });
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

  it("tells the API where playback is when it starts and when it pauses, so the Shelf can resume there", () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const s = session();
    act(() => s().open("b1"));
    timeUpdate(12.3456);

    act(() => s().toggle());
    timeUpdate(20);
    act(() => s().toggle());

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method, JSON.parse(init.body as string)])).toEqual([
      ["/api/books/b1/listening", "PUT", { positionMs: 12345 }],
      ["/api/books/b1/listening", "PUT", { positionMs: 20000 }],
    ]);
  });

  it("does not report the previous Book's position as the next one's while switching Books", () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const s = session();
    act(() => s().open("b1"));
    act(() => s().toggle());
    timeUpdate(300);
    fetchMock.mockClear();

    act(() => s().open("b2"));
    // The old stream going away stops the element at the old Book's position.
    act(() => {
      audio().dispatchEvent(new Event("pause"));
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Once the new Book's playlist is loaded, its own positions are reported.
    timeUpdate(0);
    act(() => {
      audio().dispatchEvent(new Event("loadedmetadata"));
    });
    act(() => s().toggle());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/books/b2/listening"]);
  });

  it("plays and pauses with toggle", () => {
    const s = session();
    act(() => s().open("b1"));

    act(() => s().toggle());
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(s().playing).toBe(true);

    act(() => s().toggle());
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(s().playing).toBe(false);
  });

  it("reports the position and what is playable, using what is seekable while the Book generates", () => {
    const s = session();
    act(() => s().open("b1"));
    Object.defineProperty(audio(), "seekable", { value: { length: 1, end: () => 120 }, configurable: true });

    timeUpdate(30);

    expect(s()).toMatchObject({ position: 30, playable: 120 });
  });

  it("says so when the stream cannot be played, but not for errors hls.js recovers from", () => {
    const s = session();
    act(() => s().open("b1"));
    const onError = hlsInstances[0]!.handlers.hlsError!;

    act(() => onError("hlsError", { fatal: false }));
    expect(s().error).toBeNull();

    act(() => onError("hlsError", { fatal: true }));
    expect(s().error).toBe("播放失败，请刷新页面重试");
  });

  it("reloads the playlist on a fresh audio element", () => {
    const s = session();
    act(() => s().open("b1"));
    const first = audio();

    act(() => s().reload());

    expect(audio()).not.toBe(first);
    expect(hlsInstances.map((h) => [h.source, h.destroyed])).toEqual([
      ["/api/books/b1/audio.m3u8", true],
      ["/api/books/b1/audio.m3u8", false],
    ]);
    expect(hlsInstances[1]!.media).toBe(audio());
  });

  it("stops loading when it goes away (logging out)", () => {
    const s = session();
    act(() => s().open("b1"));
    s.unmount();
    expect(hlsInstances[0]!.destroyed).toBe(true);
  });

  describe("a requested start (a Chapter picked to listen to)", () => {
    it("seeks there and plays once the playlist reaches it, then reports the request done", () => {
      const s = session();
      act(() => s().open("b1"));
      const onSettled = vi.fn();
      act(() => s().requestStart({ id: "c3", seconds: 600, autoplay: true }, onSettled));
      const { seeks } = audioWithGenerated(300);
      expect(media.play).not.toHaveBeenCalled();

      grow(610);

      expect(seeks).toEqual([600]);
      expect(media.play).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledTimes(1);
      grow(620);
      expect(seeks).toEqual([600]);
    });

    it("keeps waiting while the position is not known yet, and plays once it is", () => {
      const s = session();
      act(() => s().open("b1"));
      act(() => s().requestStart({ id: "c3", seconds: null, autoplay: true }));
      const { seeks } = audioWithGenerated(300);
      grow(900);
      expect(media.play).not.toHaveBeenCalled();

      act(() => s().requestStart({ id: "c3", seconds: 600, autoplay: true }));

      expect(seeks).toEqual([600]);
      expect(media.play).toHaveBeenCalledTimes(1);
    });

    it("starts again when the same Chapter is asked for again", () => {
      const s = session();
      act(() => s().open("b1"));
      const { seeks } = audioWithGenerated(900);
      act(() => s().requestStart({ id: "c3#1", seconds: 600, autoplay: true }));
      act(() => s().requestStart({ id: "c3#2", seconds: 600, autoplay: true }));
      expect(seeks).toEqual([600, 600]);
    });

    it("is dropped when the user plays or pauses by hand meanwhile", () => {
      const s = session();
      act(() => s().open("b1"));
      const onSettled = vi.fn();
      act(() => s().requestStart({ id: "c3", seconds: 600, autoplay: true }, onSettled));
      const { seeks } = audioWithGenerated(300);

      act(() => s().toggle());
      expect(onSettled).toHaveBeenCalledTimes(1);
      grow(610);

      expect(seeks).toEqual([]);
      expect(media.play).toHaveBeenCalledTimes(1);
    });

    it("asks for a tap, not an error, when the browser does not let it play on its own", async () => {
      media.play.mockImplementationOnce(() => Promise.reject(new DOMException("autoplay", "NotAllowedError")));
      const s = session();
      act(() => s().open("b1"));
      act(() => s().requestStart({ id: "c3", seconds: 10, autoplay: true }));
      audioWithGenerated(60);
      await act(async () => {});

      expect(s()).toMatchObject({ needsTap: true, error: null, playing: false });
    });
  });

  it("tells when playback waits at the end of the generated audio, and when it moves on again", () => {
    const s = session();
    act(() => s().open("b1"));
    act(() => s().toggle());
    const el = audio();

    // Buffering in the middle is not waiting for audio to be generated.
    timeUpdate(100, 600);
    act(() => el.dispatchEvent(new Event("waiting")));
    expect(s().waitingForAudio).toBe(false);

    timeUpdate(599.6, 600);
    act(() => el.dispatchEvent(new Event("waiting")));
    expect(s().waitingForAudio).toBe(true);

    act(() => el.dispatchEvent(new Event("playing")));
    expect(s().waitingForAudio).toBe(false);
  });
});
