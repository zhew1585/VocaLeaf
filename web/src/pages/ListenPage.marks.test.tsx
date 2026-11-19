// Marking on the 专注页 (#13, PRD 4.4.2, F8, AC-READ-04): 【标记】 and M mark the target Sentence, a Toast shows it
// with 撤销, pending Marks are underlined, and Marks made offline are sent once the network is back.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail, Sentence } from "../api";
import { PlayGuideProvider } from "../guide/PlayGuide";
import { startOutbox, stopOutbox } from "../marks/marks";
import { layoutOf } from "../player/layout";
import { ListeningProvider } from "../player/session";
import { audioWithGenerated, hlsInstances, stubMediaPlayback } from "../test-media";
import { ListenPage } from "./ListenPage";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

const chapter = (id: string, index: number, startMs: number): BookDetail["chapters"][number] => ({
  id,
  index,
  title: `Chapter ${index + 1}`,
  skipped: false,
  audioStatus: "generated",
  sentenceCount: 2,
  durationMs: 10_000,
  startMs,
  waitSeconds: null,
});

/** Chapter 1 runs 0 to 10 s, Chapter 2 from 10 s. */
const book: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  source: "upload",
  voice: "us_female",
  voiceChange: null,
  voiceChangeable: true,
  author: "Jane Austen",
  status: "ready",
  playable: true,
  failureReason: null,
  coverUrl: null,
  listening: null,
  progress: { generated: 2, narrated: 2 },
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [chapter("c1", 0, 0), chapter("c2", 1, 10_000)],
  durationMs: 20_000,
};

const sentence = (id: string, text: string, startMs: number): Sentence => ({
  id,
  index: 0,
  paragraphIndex: 0,
  text,
  spokenText: text,
  startMs,
  endMs: null,
  wordTimings: null,
});

const SENTENCES: Record<string, Sentence[]> = {
  c1: [
    sentence("s1", "It is a truth universally acknowledged, that a single man.", 0),
    sentence("s2", "However little known.", 4_000),
  ],
  c2: [sentence("t1", "Mr. Bennet was among the earliest.", 10_000), sentence("t2", "He had always intended.", 15_000)],
};
const ALL = Object.values(SENTENCES).flat();

let marked: Set<string>;
let media: ReturnType<typeof stubMediaPlayback>;
let online: boolean;
let writes: string[];

beforeEach(() => {
  startOutbox("u1");
  hlsInstances.length = 0;
  media = stubMediaPlayback();
  Element.prototype.scrollTo = vi.fn() as never;
  marked = new Set(["t2"]);
  online = true;
  writes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const sentenceId = /^\/api\/sentences\/([^/]+)\/mark$/.exec(url)?.[1];
      if (sentenceId) {
        if (!online) throw new TypeError("Failed to fetch");
        writes.push(`${method} ${sentenceId}`);
        if (method === "DELETE") {
          marked.delete(sentenceId);
          return new Response(null, { status: 204 });
        }
        const result = marked.has(sentenceId) ? "already" : "created";
        marked.add(sentenceId);
        return Response.json({ result });
      }
      const chapterId = /^\/api\/chapters\/([^/]+)\/sentences$/.exec(url)?.[1];
      if (chapterId) return Response.json(SENTENCES[chapterId] ?? []);
      if (url.endsWith("/marks")) return Response.json({ pending: [...marked] });
      if (url.endsWith("/explanation")) return Response.json({ content: null, messages: [], aiRemaining: 100 });
      if (url.endsWith("/timeline")) {
        return Response.json({
          sentenceStartsMs: ALL.map((s) => s.startMs),
          sentenceIds: ALL.map((s) => s.id),
          // The Book's own layout, settled: nothing for the session to follow.
          chapters: layoutOf(book),
          complete: true,
          settled: true,
        });
      }
      if (url === "/api/books/b1") return Response.json(book);
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  stopOutbox();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

/** Opens the 专注页 with its text shown and playback at `seconds`; returns the seeks the player makes. */
async function openAt(seconds: number) {
  render(
    <PlayGuideProvider seen>
      <ListeningProvider>
        <ListenPage id="b1" />
      </ListeningProvider>
    </PlayGuideProvider>,
  );
  await screen.findByText("He had always intended.");
  const { seeks } = audioWithGenerated(20);
  seeks.push(seconds);
  return seeks;
}

const underlined = () => [...document.querySelectorAll(".sentence.is-marked")].map((el) => el.getAttribute("data-sentence-id"));
const toast = () => screen.findByRole("status", { name: "标记提示" });

async function pressM() {
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "m" });
  });
}

describe("marking while listening (PRD 4.4.2)", () => {
  it("underlines Sentences with a pending Mark (AC-READ-04)", async () => {
    await openAt(0);
    await vi.waitFor(() => expect(underlined()).toEqual(["t2"]));
  });

  it("marks the current Sentence with M and says so with its start (AC-MARK-01)", async () => {
    await openAt(7);

    await pressM();

    expect(writes).toEqual(["PUT s2"]);
    expect((await toast()).textContent).toContain("已标记：However little known.");
    expect(underlined()).toEqual(["s2", "t2"]);
  });

  it("marks the previous Sentence when the current one began under 1.5 s ago, with the button too (AC-MARK-02)", async () => {
    await openAt(10.5);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "标记" }));
    });

    expect(writes).toEqual(["PUT s2"]);
  });

  it("shortens a long Sentence in the Toast to its first 30 characters", async () => {
    await openAt(2);
    await pressM();
    expect((await toast()).textContent).toContain("已标记：It is a truth universally ackn…");
  });

  it("says 【已标记】 for a Sentence already pending, without marking it again (AC-MARK-03)", async () => {
    await openAt(17);
    await vi.waitFor(() => expect(underlined()).toEqual(["t2"]));

    await pressM();

    const shown = await toast();
    expect(shown.textContent).toBe("已标记");
    expect(within(shown).queryByRole("button", { name: "撤销" })).toBeNull();
    expect(writes).toEqual([]);
  });

  it("deletes the Mark on 撤销 and drops the underline (AC-MARK-05)", async () => {
    await openAt(7);
    await pressM();

    await act(async () => {
      fireEvent.click(within(await toast()).getByRole("button", { name: "撤销" }));
    });

    expect(writes).toEqual(["PUT s2", "DELETE s2"]);
    expect(underlined()).toEqual(["t2"]);
    expect(screen.queryByRole("status", { name: "标记提示" })).toBeNull();
  });

  it("marks and unmarks the selected Sentence with the leaf of 句子精读, in step with the underline (AC-PANEL-13)", async () => {
    await openAt(0);
    fireEvent.click(screen.getByText("However little known."));
    const panel = screen.getByRole("complementary", { name: "句子精读" });

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "标记" }));
    });
    expect(writes).toEqual(["PUT s2"]);
    expect(underlined()).toEqual(["s2", "t2"]);
    const leaf = within(panel).getByRole("button", { name: "取消标记" });
    expect(leaf.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(leaf);
    });
    expect(writes).toEqual(["PUT s2", "DELETE s2"]);
    expect(underlined()).toEqual(["t2"]);
    expect(within(panel).getByRole("button", { name: "标记" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a Mark made offline on the device and sends it once the network is back", async () => {
    await openAt(7);
    online = false;

    await pressM();
    expect((await toast()).textContent).toContain("已标记：However little known.");
    expect(underlined()).toEqual(["s2", "t2"]);
    expect(writes).toEqual([]);

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await vi.waitFor(() => expect(writes).toEqual(["PUT s2"]));
    expect(marked.has("s2")).toBe(true);
  });

  it("never sends an offline Mark undone before the network is back", async () => {
    await openAt(7);
    online = false;
    await pressM();
    await act(async () => {
      fireEvent.click(within(await toast()).getByRole("button", { name: "撤销" }));
    });
    expect(underlined()).toEqual(["t2"]);

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await vi.waitFor(() => expect(writes).toEqual(["DELETE s2"]));
    expect(marked.has("s2")).toBe(false);
  });

  it("does not mark with M while typing", async () => {
    await openAt(7);
    const field = document.body.appendChild(document.createElement("input"));
    await act(async () => {
      fireEvent.keyDown(field, { key: "m" });
    });
    expect(writes).toEqual([]);
    field.remove();
  });
});

describe("opened by 定位原文 (F10)", () => {
  it("shows and selects the Sentence without following playback, paused, and forgets the parameters", async () => {
    window.history.pushState(null, "", "/books/b1/listen?locate=t2&locateChapter=c2");
    render(
      <PlayGuideProvider seen>
        <ListeningProvider>
          <ListenPage id="b1" />
        </ListeningProvider>
      </PlayGuideProvider>,
    );

    // In the text and, once selected, in 句子精读 too.
    expect((await screen.findAllByText("He had always intended.")).length).toBeGreaterThan(0);
    expect(Element.prototype.scrollTo).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "回到播放处" })).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(media.play).not.toHaveBeenCalled();
    // Selected, with 句子精读 open on it (F10 定位原文).
    await vi.waitFor(() =>
      expect(document.querySelector(".sentence.is-selected")?.getAttribute("data-sentence-id")).toBe("t2"),
    );
    const panel = screen.getByRole("complementary", { name: "句子精读" });
    expect(panel.querySelector(".panel-sentence-text")?.textContent).toBe("He had always intended.");
  });
});
