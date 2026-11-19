// The session's playback controls (#9): 重听, 下一句, speed, dragging, sleep timer and a network going down,
// on the session's one audio element with hls.js and the API stubbed.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookTimeline } from "../api";
import { audio, audioWithGenerated, grow, hlsInstances, stubMediaPlayback } from "../test-media";
import { ListeningProvider, useListening, type Listening } from "./session";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

/** Sentences start at 0, 4, 8, 12 and 16 s; Chapter I runs 0 to 8 s, Chapter II 8 to 20 s. */
const TIMELINE: BookTimeline = {
  sentenceStartsMs: [0, 4000, 8000, 12000, 16000],
  sentenceIds: ["s1", "s2", "s3", "s4", "s5"],
  chapters: [
    { id: "c1", startMs: 0, endMs: 8000 },
    { id: "c2", startMs: 8000, endMs: 20000 },
  ],
  complete: true,
};

let media: ReturnType<typeof stubMediaPlayback>;
beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/timeline") ? Response.json(TIMELINE) : new Response(null, { status: 204 }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

/** The provider with Book b1 open and its timeline loaded; hands back the live session. */
async function openedSession() {
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
  await act(async () => ref.current!.open("b1"));
  return () => ref.current!;
}

/** Playback moved to `seconds` by itself, as it does while playing. */
function playedTo(el: HTMLAudioElement, seconds: number) {
  Object.defineProperty(el, "currentTime", { value: seconds, configurable: true, writable: true });
}

async function press(action: () => void) {
  await act(async () => action());
}

describe("重听 (PRD 4.4.3)", () => {
  it("goes back to the previous Sentence when the current one began under 1.5 s ago (AC-REP-01)", async () => {
    const s = await openedSession();
    const { el, seeks } = audioWithGenerated(20);
    seeks.push(8.9);

    await press(() => s().replay());

    expect(el.currentTime).toBe(4);
  });

  it("replays the current Sentence from its start after that (AC-REP-02), and records nothing (AC-REP-03)", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(20);
    seeks.push(11);
    vi.mocked(fetch).mockClear();

    await press(() => s().replay());

    expect(seeks.at(-1)).toBe(8);
    // Neither a Mark nor any other write: the timeline was already loaded, so no request at all.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a paused player paused", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(20);
    seeks.push(11);
    await press(() => s().replay());
    expect(media.play).not.toHaveBeenCalled();
  });

  it("does not compensate right after a drag, until playback crosses a Sentence start (G2)", async () => {
    const s = await openedSession();
    const el = audio();
    Object.defineProperty(el, "readyState", { value: HTMLMediaElement.HAVE_METADATA, configurable: true });
    grow(20);
    act(() => s().seek(8.2));
    playedTo(el, 8.5);

    await press(() => s().replay());
    expect(el.currentTime).toBe(8);

    // ⏮ itself is not a landing: pressed again at once, it goes on back to the previous Sentence.
    await press(() => s().replay());
    expect(el.currentTime).toBe(4);
  });

  it("compensates again once playback played on past the next Sentence start", async () => {
    const s = await openedSession();
    const el = audio();
    grow(20);
    act(() => s().seek(8.2));
    playedTo(el, 12.5);

    await press(() => s().replay());
    expect(el.currentTime).toBe(8);
  });

  it("forgets a landing in the previous Book", async () => {
    const s = await openedSession();
    const el = audio();
    grow(20);
    act(() => s().seek(8.2));
    await act(async () => s().open("b2"));
    playedTo(audio(), 8.5);

    await press(() => s().replay());
    expect(audio().currentTime).toBe(4);
    expect(el).toBe(audio());
  });
});

describe("下一句", () => {
  it("jumps to the next Sentence's start, and stays at the last Sentence", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(20);
    seeks.push(5);

    await press(() => s().next());
    expect(seeks.at(-1)).toBe(8);

    seeks.push(17);
    await press(() => s().next());
    expect(seeks.at(-1)).toBe(17);
  });

  it("loads the timeline again when playback is past what it holds (the Book is still generating)", async () => {
    const growing: BookTimeline = { ...TIMELINE, sentenceStartsMs: [0, 4000], sentenceIds: ["s1", "s2"], complete: false };
    vi.mocked(fetch)
      .mockImplementationOnce(async () => Response.json(growing))
      .mockImplementationOnce(async () => Response.json(TIMELINE));
    const s = await openedSession();
    const { seeks } = audioWithGenerated(20);
    seeks.push(5);

    await press(() => s().next());

    expect(seeks.at(-1)).toBe(8);
  });
});

describe("speed (AC-PLAY-06)", () => {
  it("applies the chosen speed and keeps it for the next Book and the next visit", async () => {
    const s = await openedSession();
    act(() => s().setSpeed(1.5));
    expect(audio().playbackRate).toBe(1.5);

    await act(async () => s().open("b2"));
    expect(s().speed).toBe(1.5);
    expect(audio().playbackRate).toBe(1.5);
    expect(localStorage.getItem("vocaleaf.speed")).toBe("1.5");
  });
});

describe("dragging the progress bar (AC-PLAY-21)", () => {
  it("moves to the exact position, not a Sentence start, keeping a paused player paused", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(60);

    act(() => s().seek(30.4));

    expect(seeks).toEqual([30.4]);
    expect(media.play).not.toHaveBeenCalled();
  });

  it("keeps a playing player playing", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(60);
    act(() => s().toggle());

    act(() => s().seek(30.4));

    expect(seeks).toEqual([30.4]);
    expect(media.pause).not.toHaveBeenCalled();
  });

  it("past the generated audio, waits there and plays on once it is generated", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(60);
    act(() => s().toggle());

    act(() => s().seek(100));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(s().seekPending).toBe(true);

    grow(120);
    expect(seeks).toEqual([100]);
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(s().seekPending).toBe(false);
  });
});

describe("sleep timer (AC-PLAY-07, G9)", () => {
  it("fades out and pauses when the minutes are up, then is off", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const s = await openedSession();
    audioWithGenerated(5000);
    act(() => s().toggle());
    act(() => s().setSleep(15));
    expect(s().sleepRemaining()).toBe(15 * 60_000);

    act(() => vi.advanceTimersByTime(15 * 60_000 - 1500));
    expect(audio().volume).toBeCloseTo(0.5, 1);
    expect(media.pause).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1500));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(audio().volume).toBe(1);
    expect(s().sleep).toBeNull();
  });

  it("counts on while paused and just ends if playback is paused when it runs out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const s = await openedSession();
    audioWithGenerated(5000);
    act(() => s().setSleep(15));

    act(() => vi.advanceTimersByTime(15 * 60_000));

    expect(s().sleep).toBeNull();
    expect(media.pause).not.toHaveBeenCalled();
  });

  it("pauses at the end of the Chapter playing when set, or of the Chapter a jump landed in", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const s = await openedSession();
    const el = audio();
    grow(20);
    act(() => s().toggle());
    playedTo(el, 3);
    act(() => s().setSleep("chapter"));
    expect(s().sleepRemaining()).toBe(5000);

    // Dragged into Chapter II: its end counts now.
    act(() => s().seek(9));
    playedTo(el, 10);
    act(() => vi.advanceTimersByTime(250));
    expect(s().sleepRemaining()).toBe(10_000);

    playedTo(el, 20.1);
    act(() => vi.advanceTimersByTime(250));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(s().sleep).toBeNull();
  });

  it("is turned off with 【关闭定时】", async () => {
    const s = await openedSession();
    act(() => s().setSleep(30));
    act(() => s().setSleep(null));
    expect(s().sleep).toBeNull();
    expect(s().sleepRemaining()).toBeNull();
  });
});

describe("the Book's end (AC-PLAY-20)", () => {
  it("is paused there, with the position at the end", async () => {
    const s = await openedSession();
    const el = audio();
    grow(20);
    act(() => s().toggle());
    playedTo(el, 20);
    act(() => {
      Object.defineProperty(el, "paused", { value: true, configurable: true });
      el.dispatchEvent(new Event("timeupdate"));
      el.dispatchEvent(new Event("pause"));
      el.dispatchEvent(new Event("ended"));
    });
    expect(s()).toMatchObject({ playing: false, position: 20 });
  });
});

describe("network down (F7 异常处理)", () => {
  it("pauses and says so, without calling it a playback failure, and plays on once the network is back", async () => {
    const s = await openedSession();
    act(() => s().toggle());
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => hlsInstances[0]!.handlers.hlsError!("hlsError", { fatal: true }));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(s()).toMatchObject({ offline: true, playing: false, error: null });

    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(s()).toMatchObject({ offline: false, playing: true });
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(hlsInstances[0]!.restarted).toBe(true);
  });

  it("does not play another Book that opened while offline", async () => {
    const s = await openedSession();
    act(() => s().toggle());
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => s().open("b2"));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("stays paused when the user had paused before the network went down", async () => {
    const s = await openedSession();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(media.play).not.toHaveBeenCalled();
    expect(s().offline).toBe(false);
  });
});
