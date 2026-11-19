// 试听 and 从这里播放 against the main playback (PRD 4.4.1 试听与主播放, AC-PLAY-12 to AC-PLAY-15), on the session's
// audio elements with hls.js and the API stubbed.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookTimeline } from "../api";
import { audio, audioWithGenerated, hlsInstances, stubMediaPlayback } from "../test-media";
import { ListeningProvider, useListening, type Listening } from "./session";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

/** Sentences start at 0, 4, 8, 12 and 16 s. */
const TIMELINE: BookTimeline = {
  sentenceStartsMs: [0, 4000, 8000, 12000, 16000],
  sentenceIds: ["s1", "s2", "s3", "s4", "s5"],
  chapters: [{ id: "c1", startMs: 0, endMs: 20000 }],
  complete: true,
  settled: true,
};
/** The Sentence 试听 plays: 12 to 15.7 s of the Book's audio. */
const FOURTH = { id: "s4", startMs: 12_000, endMs: 15_700 };

let media: ReturnType<typeof stubMediaPlayback>;
beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url.endsWith("/timeline") ? Response.json(TIMELINE) : new Response(null, { status: 204 }))),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

function auditionAudio(): HTMLAudioElement {
  return document.querySelectorAll("audio")[1] as HTMLAudioElement;
}

/** The 试听 element reached `seconds` of the Book's audio. */
function auditionAt(seconds: number) {
  const el = auditionAudio();
  Object.defineProperty(el, "currentTime", { value: seconds, configurable: true, writable: true });
  act(() => el.dispatchEvent(new Event("timeupdate")));
}

const playedOn = (el: HTMLAudioElement) => media.play.mock.contexts.filter((c) => c === el).length;

/** The main playback plays at `seconds` (in its third Sentence when 9). */
function mainPlayingAt(s: () => Listening, seconds: number) {
  const { el, seeks } = audioWithGenerated(20);
  act(() => s().toggle());
  seeks.push(seconds);
  return { el, seeks };
}

describe("试听本句", () => {
  it("loads only that Sentence's audio on its own element, from the Sentence's start", async () => {
    const s = await openedSession();

    act(() => s().startAudition(FOURTH));

    const hls = hlsInstances.at(-1)!;
    expect(hls.media).toBe(auditionAudio());
    expect(hls.source).toBe("/api/books/b1/audio.m3u8");
    expect(hls.config).toMatchObject({ startPosition: 12 });
    expect(playedOn(auditionAudio())).toBe(1);
    expect(s().audition).toEqual({ id: "s4", loading: true, failed: false, paused: false });

    act(() => auditionAudio().dispatchEvent(new Event("playing")));
    expect(s().audition).toEqual({ id: "s4", loading: false, failed: false, paused: false });
  });

  it("pauses where it is and plays on from there, still stopping at the Sentence's end", async () => {
    const s = await openedSession();
    act(() => s().startAudition(FOURTH));
    act(() => auditionAudio().dispatchEvent(new Event("playing")));
    auditionAt(13.5);
    const loads = hlsInstances.length;

    act(() => s().pauseAudition());
    expect(media.pause.mock.contexts).toContain(auditionAudio());
    expect(s().audition).toEqual({ id: "s4", loading: false, failed: false, paused: true });

    act(() => s().resumeAudition());
    // The same audio on, from 13.5 s: nothing loads again and nothing seeks.
    expect(playedOn(auditionAudio())).toBe(2);
    expect(hlsInstances).toHaveLength(loads);
    expect(auditionAudio().currentTime).toBe(13.5);
    expect(s().audition).toEqual({ id: "s4", loading: false, failed: false, paused: false });

    auditionAt(15.7);
    expect(s().audition).toBeNull();
  });

  it("keeps an interrupted main playback paused while the 试听 is paused, and goes on once it is read", async () => {
    const s = await openedSession();
    const { el, seeks } = mainPlayingAt(s, 9);
    act(() => s().startAudition(FOURTH));

    act(() => s().pauseAudition());
    expect(el.paused).toBe(true);
    expect(s().playing).toBe(false);

    act(() => s().resumeAudition());
    auditionAt(15.7);
    expect(seeks.at(-1)).toBe(8);
    expect(s().playing).toBe(true);
  });

  it("interrupts the main playback, then goes on from the start of the interrupted Sentence (AC-PLAY-12)", async () => {
    const s = await openedSession();
    const { el, seeks } = mainPlayingAt(s, 9);

    act(() => s().startAudition(FOURTH));
    expect(el.paused).toBe(true);
    expect(s().playing).toBe(false);

    auditionAt(14);
    expect(s().audition).not.toBeNull();
    auditionAt(15.7);

    expect(s().audition).toBeNull();
    expect(seeks.at(-1)).toBe(8);
    expect(s().playing).toBe(true);
  });

  it("leaves a paused main playback paused and where it was (AC-PLAY-13, AC-PANEL-05)", async () => {
    const s = await openedSession();
    const { el, seeks } = audioWithGenerated(20);
    seeks.push(9.5);

    act(() => s().startAudition(FOURTH));
    auditionAt(15.7);

    expect(s().audition).toBeNull();
    expect(el.paused).not.toBe(false);
    expect(playedOn(audio())).toBe(0);
    expect(seeks.at(-1)).toBe(9.5);
  });

  it("stops on Space or 暂停 and does not go on with the main playback (AC-PLAY-14)", async () => {
    const s = await openedSession();
    const { seeks } = mainPlayingAt(s, 9);
    act(() => s().startAudition(FOURTH));

    act(() => s().toggle());

    expect(s().audition).toBeNull();
    expect(auditionAudio().paused).toBe(true);
    expect(s().playing).toBe(false);
    auditionAt(15.7);
    expect(seeks.at(-1)).toBe(9);
    expect(s().playing).toBe(false);
  });

  it("plays the Sentence again from its start when asked again, still going on afterwards", async () => {
    const s = await openedSession();
    const { seeks } = mainPlayingAt(s, 9);
    act(() => s().startAudition(FOURTH));
    auditionAt(14);

    act(() => s().startAudition(FOURTH));

    expect(hlsInstances.at(-1)!.config).toMatchObject({ startPosition: 12 });
    expect(playedOn(auditionAudio())).toBe(2);
    auditionAt(15.7);
    expect(seeks.at(-1)).toBe(8);
    expect(s().playing).toBe(true);
  });

  it("is stopped by selecting another Sentence without the main playback going on", async () => {
    const s = await openedSession();
    mainPlayingAt(s, 9);
    act(() => s().startAudition(FOURTH));

    act(() => s().stopAudition());

    expect(s().audition).toBeNull();
    expect(s().playing).toBe(false);
  });
});

describe("从这里播放", () => {
  it("plays the main playback from the Sentence's start, even when paused (AC-PLAY-15)", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(20);

    act(() => s().playFrom(12));

    expect(seeks.at(-1)).toBe(12);
    expect(s().playing).toBe(true);
  });

  it("stops a 试听 at once", async () => {
    const s = await openedSession();
    const { seeks } = audioWithGenerated(20);
    act(() => s().startAudition(FOURTH));

    act(() => s().playFrom(4));

    expect(s().audition).toBeNull();
    expect(seeks.at(-1)).toBe(4);
    expect(s().playing).toBe(true);
  });
});
