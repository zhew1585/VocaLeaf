import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOK_DELETED_EVENT, type BookDetail } from "../api";
import { audio, audioWithGenerated, grow, hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";
import { layoutOf } from "./layout";
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

/** The calls that told the API where playback is (the session also loads the Book's timeline). */
function listeningCalls(fetchMock: { mock: { calls: [string, RequestInit][] } }) {
  return fetchMock.mock.calls.filter(([url]) => url.endsWith("/listening"));
}

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

    expect(listeningCalls(fetchMock).map(([url, init]) => [url, init.method, JSON.parse(init.body as string)])).toEqual([
      ["/api/books/b1/listening", "PUT", { positionMs: 12346 }],
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
    // Only the save of the old Book as the switch began (AC-PLAY-16).
    expect(listeningCalls(fetchMock).map(([url, init]) => [url, JSON.parse(init.body as string)])).toEqual([
      ["/api/books/b1/listening", { positionMs: 300000 }],
    ]);
    fetchMock.mockClear();

    // Once the new Book's playlist is loaded, its own positions are reported.
    timeUpdate(0);
    act(() => {
      audio().dispatchEvent(new Event("loadedmetadata"));
    });
    act(() => s().toggle());
    expect(listeningCalls(fetchMock).map(([url]) => url)).toEqual(["/api/books/b2/listening"]);
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

  describe("following the Book's playlist (a Chapter set Skipped, narrated or retried)", () => {
    type Chapter = BookDetail["chapters"][number];
    const chapter = (id: string, index: number, startMs: number | null, rest: Partial<Chapter> = {}): Chapter => ({
      id,
      index,
      title: id,
      skipped: startMs === null,
      audioStatus: "generated",
      sentenceCount: 3,
      durationMs: 300_000,
      startMs,
      waitSeconds: null,
      ...rest,
    });
    const detail = (chapters: Chapter[]): BookDetail => ({
      id: "b1",
      source: "upload",
      title: "Pride and Prejudice",
      author: null,
      status: "ready",
      playable: true,
      failureReason: null,
      coverUrl: null,
      listening: null,
      progress: { generated: 3, narrated: 3 },
      createdAt: "2026-11-18T00:00:00.000Z",
      chapters,
      durationMs: 900_000,
    });
    // Three 5-minute Chapters.
    const three = detail([chapter("I", 0, 0), chapter("II", 1, 300_000), chapter("III", 2, 600_000)]);
    const twoSkipped = detail([chapter("I", 0, 0), chapter("II", 1, null), chapter("III", 2, 300_000)]);

    /** The session holding b1, playing at `seconds` of the playlist laid out as `book`. */
    function playingAt(book: BookDetail, seconds: number) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      const s = session();
      act(() => s().open("b1"));
      act(() => s().follow(book));
      audioWithGenerated(900).seeks.push(seconds);
      act(() => s().toggle());
      return s;
    }

    it("plays on undisturbed while the playlist only grows", () => {
      const s = playingAt(detail([chapter("I", 0, 0), chapter("II", 1, null, { skipped: false, audioStatus: "generating" })]), 100);
      act(() => s().follow(three));
      expect(hlsInstances).toHaveLength(1);
    });

    it("moves to the start of the next narrated Chapter when the playing one is set Skipped, still playing (AC-BOOK-02)", () => {
      const s = playingAt(three, 400);
      act(() => s().follow(twoSkipped));

      expect(hlsInstances).toHaveLength(2);
      const reloaded = audioWithGenerated(600);
      expect(reloaded.seeks).toEqual([300]);
      expect(media.play).toHaveBeenCalledTimes(2);
      expect(s().playing).toBe(true);
    });

    it("keeps the place in the playing Chapter when a Chapter before it leaves or comes back, paused if it was", () => {
      const s = playingAt(three, 700);
      act(() => s().toggle());
      act(() => s().follow(twoSkipped));
      const shorter = audioWithGenerated(600);
      expect(shorter.seeks).toEqual([400]);

      act(() => s().follow(three));
      expect(audioWithGenerated(900).seeks).toEqual([700]);
      expect(media.play).toHaveBeenCalledTimes(1);
      expect(s().playing).toBe(false);
    });

    it("follows its own timeline when no page shows the Book: the playing Chapter set Skipped elsewhere", async () => {
      let served = three;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.endsWith("/timeline")
            ? Response.json({ sentenceStartsMs: [], chapters: layoutOf(served), complete: true, settled: false })
            : new Response(null, { status: 204 }),
        ),
      );
      const s = session();
      act(() => s().open("b1"));
      await vi.waitFor(() => expect(s().bookId).toBe("b1"));
      audioWithGenerated(900).seeks.push(400);
      act(() => s().toggle());

      served = twoSkipped;
      // Not settled, so loaded again every 10 seconds.
      await vi.waitFor(() => expect(hlsInstances).toHaveLength(2), { timeout: 12_000 });
      expect(audioWithGenerated(600).seeks).toEqual([300]);
      expect(media.play).toHaveBeenCalledTimes(2);
    }, 15_000);

    it("ignores another Book's playlist", () => {
      const s = playingAt(three, 400);
      act(() => s().follow({ ...twoSkipped, id: "b2" }));
      expect(hlsInstances).toHaveLength(1);
    });
  });

  it("ends when its Book is deleted, and only then (#8)", () => {
    const s = session();
    act(() => s().open("b1"));
    act(() => s().toggle());

    act(() => {
      window.dispatchEvent(new CustomEvent(BOOK_DELETED_EVENT, { detail: "b2" }));
    });
    expect(s()).toMatchObject({ bookId: "b1", playing: true });

    act(() => {
      window.dispatchEvent(new CustomEvent(BOOK_DELETED_EVENT, { detail: "b1" }));
    });
    expect(s()).toMatchObject({ bookId: null, playing: false, position: 0 });
    expect(hlsInstances.map((h) => h.destroyed)).toEqual([true]);

    // The session forgot the Book: opening the same id again loads it anew instead of being ignored.
    act(() => s().open("b1"));
    expect(hlsInstances).toHaveLength(2);
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

describe("syncing listening progress (PRD 4.4.1 进度同步, #10)", () => {
  /** Answers progress reports with 204 and anything else with `other`. */
  function serve(other: (url: string) => Response = () => Response.json({ sentenceStartsMs: [], chapters: [], complete: true })) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/listening") ? new Response(null, { status: 204 }) : other(url),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const reported = (fetchMock: ReturnType<typeof serve>) =>
    listeningCalls(fetchMock as never).map(([url, init]) => [url, JSON.parse(init.body as string).positionMs]);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs every 15 seconds while playing, and not while paused", () => {
    vi.useFakeTimers();
    const fetchMock = serve();
    const s = session();
    act(() => s().open("b1"));
    act(() => s().toggle());
    fetchMock.mockClear();

    timeUpdate(14);
    act(() => vi.advanceTimersByTime(14_999));
    expect(reported(fetchMock)).toEqual([]);
    timeUpdate(15);
    act(() => vi.advanceTimersByTime(1));
    timeUpdate(30);
    act(() => vi.advanceTimersByTime(15_000));
    expect(reported(fetchMock)).toEqual([
      ["/api/books/b1/listening", 15000],
      ["/api/books/b1/listening", 30000],
    ]);

    act(() => s().toggle());
    fetchMock.mockClear();
    act(() => vi.advanceTimersByTime(60_000));
    expect(reported(fetchMock)).toEqual([]);
  });

  it("syncs when the page is hidden or left, with a request that outlives the page, once per position", () => {
    const fetchMock = serve();
    const s = session();
    act(() => s().open("b1"));
    act(() => s().toggle());
    timeUpdate(42);
    fetchMock.mockClear();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    const calls = listeningCalls(fetchMock as never);
    expect(calls.map(([, init]) => init.keepalive)).toEqual([true]);
    expect(reported(fetchMock)).toEqual([["/api/books/b1/listening", 42000]]);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("does not sync a paused session that did not move, so it never overwrites another device's progress", () => {
    const fetchMock = serve();
    const s = session();
    act(() => s().open("b1"));
    act(() => s().requestStart({ id: "resume", seconds: 300, autoplay: false }));
    audioWithGenerated(900);
    fetchMock.mockClear();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(reported(fetchMock)).toEqual([]);

    // A drag while paused is progress of this device's own: it is synced at once, and only once.
    act(() => s().seek(400));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(reported(fetchMock)).toEqual([["/api/books/b1/listening", 400000]]);
  });

  it("saves the previous Book's progress when switching to another one (AC-PLAY-16)", () => {
    const fetchMock = serve();
    const s = session();
    act(() => s().open("b1"));
    act(() => s().toggle());
    timeUpdate(300);
    fetchMock.mockClear();

    act(() => s().open("b2"));

    expect(reported(fetchMock)).toEqual([["/api/books/b1/listening", 300000]]);
    expect(s()).toMatchObject({ bookId: "b2", playing: false });
  });

  it("sends a paused position again at the next chance when its sync failed", async () => {
    let down = true;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/listening") && down) throw new TypeError("offline");
      return url.endsWith("/listening") ? new Response(null, { status: 204 }) : Response.json({ sentenceStartsMs: [], chapters: [], complete: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = session();
    act(() => s().open("b1"));
    audioWithGenerated(900);
    act(() => s().seek(400));
    await act(async () => {});
    down = false;

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(reported(fetchMock as never)).toEqual([
      ["/api/books/b1/listening", 400000],
      ["/api/books/b1/listening", 400000],
    ]);
  });

  describe("back on the page, paused", () => {
    const starts = [0, 300_000, 612_500, 900_000];
    const withListening = (startMs: number) => ({
      id: "b1",
      listening: { sentenceId: "s", chapterTitle: "Chapter 1", share: 0.5, startMs, listenedAt: "2026-11-18T00:00:00.000Z" },
    });
    const show = async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };

    /** A session paused at 5:00 as resumed from the API, with the other device now at `otherMs`. */
    async function pausedAt300(otherMs: number) {
      const fetchMock = serve((url) =>
        url === "/api/books/b1" ? Response.json(withListening(otherMs)) : Response.json({ sentenceStartsMs: starts, chapters: [], complete: true }),
      );
      const s = session();
      act(() => s().open("b1"));
      act(() => s().requestStart({ id: "resume", seconds: 300, autoplay: false }));
      const media = audioWithGenerated(1_200);
      await act(async () => {}); // the timeline loads
      return { s, fetchMock, ...media };
    }

    it("moves to the Sentence another device synced meanwhile, staying paused", async () => {
      const { seeks } = await pausedAt300(900_000);

      await show();

      expect(seeks).toEqual([300, 900]);
      expect(media.play).not.toHaveBeenCalled();
    });

    it("stays where it is when the API holds the same Sentence", async () => {
      const { seeks } = await pausedAt300(300_000);
      await show();
      expect(seeks).toEqual([300]);
    });

    it("keeps a position this device moved and has not synced yet", async () => {
      const { s, seeks, fetchMock } = await pausedAt300(900_000);
      // The drag's sync is still on its way.
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/listening") ? new Promise<Response>(() => {}) : Response.json(withListening(900_000)),
      );
      act(() => s().seek(400));

      await show();

      expect(seeks.at(-1)).toBe(400);
    });
  });

  describe("after a reload", () => {
    const book = (rest: object = {}) => ({
      id: "b1",
      title: "Pride and Prejudice",
      playable: true,
      listening: { sentenceId: "s9", chapterTitle: "Chapter 2", share: 0.4, startMs: 612_500, listenedAt: "2026-11-18T00:00:00.000Z" },
      chapters: [],
      ...rest,
    });

    it("restores this device's session, paused at the last synced Sentence", async () => {
      localStorage.setItem("vocaleaf:listening-book", "b1");
      const fetchMock = serve((url) => (url === "/api/books/b1" ? Response.json(book()) : Response.json({ sentenceStartsMs: [], chapters: [], complete: true })));
      const s = session();
      await vi.waitFor(() => expect(s().bookId).toBe("b1"));

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([612.5]);
      expect(media.play).not.toHaveBeenCalled();
      expect(s().playing).toBe(false);
      expect(fetchMock).toHaveBeenCalledWith("/api/books/b1", undefined);
    });

    it("remembers the Book opened last, and forgets it once that Book is deleted", () => {
      serve();
      const s = session();
      act(() => s().open("b1"));
      act(() => s().open("b2"));
      expect(localStorage.getItem("vocaleaf:listening-book")).toBe("b2");

      act(() => {
        window.dispatchEvent(new CustomEvent(BOOK_DELETED_EVENT, { detail: "b2" }));
      });
      expect(localStorage.getItem("vocaleaf:listening-book")).toBeNull();
    });

    it("forgets a Book that is gone, and leaves a Book opened meanwhile alone", async () => {
      localStorage.setItem("vocaleaf:listening-book", "b1");
      serve((url) =>
        url === "/api/books/b1" ? Response.json({ error: { code: "not_found", message: "没有这本书" } }, { status: 404 }) : Response.json({ sentenceStartsMs: [], chapters: [], complete: true }),
      );
      const s = session();
      await vi.waitFor(() => expect(localStorage.getItem("vocaleaf:listening-book")).toBeNull());
      expect(s().bookId).toBeNull();

      localStorage.setItem("vocaleaf:listening-book", "b1");
      let answer: (r: Response) => void = () => {};
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
      cleanup();
      const t = session();
      act(() => t().open("b2"));
      await act(async () => answer(Response.json(book())));
      expect(t().bookId).toBe("b2");
    });
  });
});
