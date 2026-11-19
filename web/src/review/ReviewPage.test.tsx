// 复习页 (#16, PRD 4.5.3, F13, design 06) driven through the whole app as a user: the navigation entry and its
// count, the front with the Card's audio and the blank, 显示答案 and the four ratings by click and by key, the
// queue the API answers with, 今日复习完成, a failed audio, and the main playback staying paused (AC-REV-07).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail, Card, ReviewItem } from "../api";
import { App } from "../App";
import { hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  sentenceId: `s-${id}`,
  targetText: "in want of",
  targetKind: "phrase",
  targetStart: 99,
  targetEnd: 109,
  sentenceText: "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
  contextBefore: null,
  contextAfter: null,
  bookTitle: "Pride and Prejudice",
  back: { kind: "phrase", meaning: "需要；缺少", usage: "be in want of sth，偏书面，相当于 need。", example: "The old house is in want of repair." },
  hasAudio: true,
  due: "2026-11-18T00:00:00.000Z",
  createdAt: "2026-11-18T00:00:00.000Z",
  ...over,
});

const phrase = card("k1");
const whole = card("k2", {
  targetText: "She runs a bakery in the village.",
  targetKind: "sentence",
  targetStart: 0,
  targetEnd: 33,
  sentenceText: "She runs a bakery in the village.",
  back: { kind: "sentence", translation: "她在村里开了一家面包店。", grammar: ["run 在此意为经营"] },
});

const item = (c: Card): ReviewItem => ({ card: c, intervalsMs: [MINUTE, 6 * MINUTE, 10 * MINUTE, 2 * DAY] });

const pride: BookDetail = {
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
  progress: { generated: 1, narrated: 1 },
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [
    { id: "c1", index: 0, title: "Chapter 1", skipped: false, audioStatus: "generated", sentenceCount: 3, durationMs: 60_000, startMs: 0, waitSeconds: null },
  ],
  durationMs: 60_000,
};

let queue: ReviewItem[];
/** What the API answers a rating with; by default the queue without the rated Card. */
let afterRating: (cardId: string) => Response;
let ratings: { cardId: string; rating: number }[];
let media: ReturnType<typeof stubMediaPlayback>;
const reviewedToday = () => new Set(ratings.map((r) => r.cardId)).size;

beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
  Element.prototype.scrollTo = vi.fn() as never;
  queue = [item(phrase), item(whole)];
  ratings = [];
  afterRating = (cardId) => {
    queue = queue.filter((i) => i.card.id !== cardId);
    return Response.json({ cards: queue, reviewedToday: reviewedToday() });
  };
  window.history.pushState(null, "", "/review");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app", playGuideSeen: true });
      if (url === "/api/review") return Response.json({ cards: queue, reviewedToday: reviewedToday() });
      if (url === "/api/review/count") return Response.json({ count: queue.length });
      const rated = /^\/api\/cards\/([^/]+)\/review$/.exec(url);
      if (rated && method === "POST") {
        ratings.push({ cardId: rated[1]!, rating: (JSON.parse(init!.body as string) as { rating: number }).rating });
        return afterRating(rated[1]!);
      }
      if (url === "/api/books/b1") return Response.json(pride);
      if (url.endsWith("/listening")) return new Response(null, { status: 204 });
      if (url.endsWith("/timeline")) {
        return Response.json({ sentenceStartsMs: [0, 20_000, 40_000], chapters: [{ id: "c1", startMs: 0, endMs: 60_000 }], complete: true });
      }
      return Response.json([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

const elements = () => [...document.querySelectorAll("audio")];
/** The main playback's element and the 试听 element the Card's audio plays on. */
const mainAudio = () => elements()[0]!;
const cardAudio = () => elements()[1]!;
const playedOn = (el: HTMLAudioElement) => media.play.mock.contexts.filter((c) => c === el).length;
const navEntry = () => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("link", { name: /复习/ });
const badge = () => navEntry().querySelector(".side-badge")?.textContent ?? null;
const press = (key: string) => act(async () => void fireEvent.keyDown(window, { key }));
const click = (el: Element) => act(async () => void fireEvent.click(el));
const progress = () => screen.getByText(/^\d+ \/ \d+$/).textContent;

/** Opens /review and waits for the first front, its audio started. */
async function enter() {
  render(<App />);
  const reveal = await screen.findByRole("button", { name: "显示答案" });
  await act(async () => {});
  return reveal;
}

describe("复习页 (F13)", () => {
  it("is in the navigation with today's count, current on the page", async () => {
    await enter();

    await vi.waitFor(() => expect(badge()).toBe("2"));
    expect(navEntry().getAttribute("aria-current")).toBe("page");
  });

  it("plays the Card's own audio on the front with the Target blanked out (AC-REV-01)", async () => {
    await enter();

    const front = screen.getByText(/It is a truth universally acknowledged/);
    expect(front.textContent).not.toContain("in want of");
    expect(within(front).getByRole("img", { name: "空缺" })).toBeTruthy();
    expect(cardAudio().getAttribute("src")).toBe("/api/cards/k1/audio");
    expect(playedOn(cardAudio())).toBe(1);
    expect(playedOn(mainAudio())).toBe(0);
    expect(progress()).toBe("0 / 2");
  });

  it("shows the whole Sentence, the back, the source and the intervals after 显示答案 (AC-REV-03)", async () => {
    await click(await enter());

    const target = screen.getByText("in want of", { selector: "mark" });
    expect(target.closest("p")!.textContent).toBe(phrase.sentenceText);
    expect(screen.getByText("需要；缺少")).toBeTruthy();
    expect(screen.getByText("be in want of sth，偏书面，相当于 need。")).toBeTruthy();
    expect(screen.getByText("The old house is in want of repair.")).toBeTruthy();
    expect(screen.getByText("Pride and Prejudice")).toBeTruthy();
    const buttons = within(screen.getByRole("group", { name: "评分" })).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["忘了1 分钟1", "困难6 分钟2", "记得10 分钟3", "简单2 天4"]);
    expect(screen.queryByRole("button", { name: "显示答案" })).toBeNull();
  });

  it("reveals with Space and rates with 1 to 4, going on with the queue the API answers with", async () => {
    await enter();

    await press("3");
    expect(ratings).toEqual([]);
    await press(" ");
    await press("3");

    expect(ratings).toEqual([{ cardId: "k1", rating: 3 }]);
    // A whole-Sentence Card only plays: no text on its front (AC-REV-02).
    expect(await screen.findByRole("button", { name: "显示答案" })).toBeTruthy();
    expect(screen.queryByText(whole.sentenceText)).toBeNull();
    expect(cardAudio().getAttribute("src")).toBe("/api/cards/k2/audio");
    expect(playedOn(cardAudio())).toBe(2);
    expect(progress()).toBe("1 / 2");

    await press(" ");
    expect(screen.getByText(whole.sentenceText)).toBeTruthy();
    expect(screen.getByText("她在村里开了一家面包店。")).toBeTruthy();
  });

  it("shows a Card due again today again, and 今日复习完成 with the count once the queue is empty (AC-REV-06)", async () => {
    afterRating = (cardId) => {
      // 忘了 keeps the first Card due today, after the other one.
      const [first, ...rest] = queue;
      queue = ratings.length === 1 ? [...rest, first!] : queue.filter((i) => i.card.id !== cardId);
      return Response.json({ cards: queue, reviewedToday: reviewedToday() });
    };
    await click(await enter());
    await click(screen.getByRole("button", { name: /忘了/ }));
    expect(progress()).toBe("0 / 2");

    for (let i = 0; i < 2; i++) {
      await click(await screen.findByRole("button", { name: "显示答案" }));
      await click(screen.getByRole("button", { name: /简单/ }));
    }

    expect(await screen.findByRole("heading", { name: "今日复习完成" })).toBeTruthy();
    expect(screen.getByText("2").closest("p")!.textContent).toBe("2 张");
    expect(ratings.map((r) => r.rating)).toEqual([1, 4, 4]);
    await vi.waitFor(() => expect(badge()).toBeNull());
  });

  it("says there is nothing to review when the queue is empty on entering", async () => {
    queue = [];
    render(<App />);

    expect(await screen.findByRole("heading", { name: "今天没有要复习的卡片" })).toBeTruthy();
  });

  it("shows 今日复习完成 with today's count when coming back after finishing", async () => {
    queue = [];
    ratings = [{ cardId: "k1", rating: 3 }, { cardId: "k2", rating: 4 }, { cardId: "k1", rating: 3 }];
    render(<App />);

    expect(await screen.findByRole("heading", { name: "今日复习完成" })).toBeTruthy();
    expect(screen.getByText("2").closest("p")!.textContent).toBe("2 张");
  });

  it("shows 音频加载失败 when the audio fails, and still reveals and rates", async () => {
    await enter();

    await act(async () => void cardAudio().dispatchEvent(new Event("error")));

    expect(screen.getByRole("alert").textContent).toBe("音频加载失败");
    await press(" ");
    await press("4");
    expect(ratings).toEqual([{ cardId: "k1", rating: 4 }]);
  });

  it("waits for a tap when the browser refuses to play on its own (PRD G12)", async () => {
    media.play.mockImplementationOnce(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
    await enter();

    expect(screen.getByRole("button", { name: "播放原声" }).parentElement!.className).not.toContain("is-playing");
    await click(screen.getByRole("button", { name: "播放原声" }));
    expect(playedOn(cardAudio())).toBe(2);
    expect(screen.getByRole("button", { name: "播放原声" }).parentElement!.className).toContain("is-playing");
  });

  it("says when a Card has no audio, and shows a whole-Sentence one's text instead", async () => {
    queue = [item({ ...whole, hasAudio: false })];
    await enter();

    expect(screen.getByText("这张卡片没有原声")).toBeTruthy();
    expect(screen.getByText(whole.sentenceText)).toBeTruthy();
    expect(screen.getByRole("button", { name: "播放原声" })).toHaveProperty("disabled", true);
    expect(playedOn(cardAudio())).toBe(0);
  });

  it("goes on when the Card was deleted meanwhile", async () => {
    afterRating = () => {
      queue = queue.slice(1);
      return Response.json({ error: { code: "not_found", message: "卡片不存在" } }, { status: 404 });
    };
    await enter();
    await press(" ");
    await press("1");

    await vi.waitFor(() => expect(cardAudio().getAttribute("src")).toBe("/api/cards/k2/audio"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the Card and says so when rating fails", async () => {
    afterRating = () => Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: 500 });
    await enter();
    await press(" ");
    await press("2");

    expect(screen.getByRole("alert").textContent).toBe("服务器出错了，请稍后再试");
    expect(screen.getByRole("group", { name: "评分" })).toBeTruthy();
  });
});

describe("the main playback in 复习 (AC-REV-07)", () => {
  it("pauses on entering, shows 已暂停, and stays paused through the Cards and after", async () => {
    window.history.pushState(null, "", "/books/b1/listen");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    timeUpdate(12);
    fireEvent.click(screen.getByRole("link", { name: "返回书架" }));
    const now = await screen.findByRole("region", { name: "当前收听" });
    expect(within(now).getByText("正在播放")).toBeTruthy();

    await click(navEntry());

    expect(await screen.findByRole("button", { name: "显示答案" })).toBeTruthy();
    expect(within(now).getByText("已暂停")).toBeTruthy();
    expect(mainAudio().paused).toBe(true);
    const mainPlays = playedOn(mainAudio());
    for (let i = 0; i < 2; i++) {
      await press(" ");
      await press("3");
    }
    // The Card's audio ending does not play the main playback on either.
    await act(async () => void cardAudio().dispatchEvent(new Event("ended")));

    expect(await screen.findByRole("heading", { name: "今日复习完成" })).toBeTruthy();
    expect(playedOn(mainAudio())).toBe(mainPlays);
    expect(within(now).getByText("已暂停")).toBeTruthy();
  });

  it("is no 插播: a Card's audio pauses the main playback the user played on, and does not play it on after (PRD 4.4.1 规则 7)", async () => {
    window.history.pushState(null, "", "/books/b1/listen");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    timeUpdate(12);
    fireEvent.click(screen.getByRole("link", { name: "返回书架" }));
    const now = await screen.findByRole("region", { name: "当前收听" });
    await click(navEntry());
    await screen.findByRole("button", { name: "显示答案" });

    // The Card's audio read, the user plays the main playback on from the sidebar, then replays the Card.
    await act(async () => void cardAudio().dispatchEvent(new Event("ended")));
    await click(within(now).getByRole("button", { name: "继续播放" }));
    expect(within(now).getByText("正在播放")).toBeTruthy();
    const mainPlays = playedOn(mainAudio());
    await click(screen.getByRole("button", { name: "播放原声" }));
    expect(within(now).getByText("已暂停")).toBeTruthy();
    await act(async () => void cardAudio().dispatchEvent(new Event("ended")));

    expect(playedOn(mainAudio())).toBe(mainPlays);
    expect(within(now).getByText("已暂停")).toBeTruthy();
  });
});
