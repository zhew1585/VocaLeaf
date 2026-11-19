// The Card list (#17, F14, design 07) through the app: the 卡片 entry, search, Book filter, a Card's detail with
// 卡片原声, 【重新生成】 and 删除, and Cards whose Book is gone.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, CardListItem } from "../api";
import { App } from "../App";
import { stubMediaPlayback } from "../test-media";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const base = {
  contextBefore: null,
  contextAfter: null,
  hasAudio: true,
  createdAt: "2026-11-18T00:00:00.000Z",
} as const;

const granted: CardListItem = {
  ...base,
  id: "k1",
  sentenceId: "s1",
  bookId: "b1",
  targetText: "granted",
  targetKind: "word",
  targetStart: 16,
  targetEnd: 23,
  sentenceText: "She took it for granted that he would come.",
  bookTitle: "Pride and Prejudice",
  back: { kind: "word", meaning: "理所当然的", phonetic: "/ˈɡrɑːntɪd/", partOfSpeech: "adj.", collocations: ["take sth for granted"] },
  due: inDays(0),
};

const inWantOf: CardListItem = {
  ...base,
  id: "k2",
  sentenceId: "s2",
  bookId: "b1",
  targetText: "in want of",
  targetKind: "phrase",
  targetStart: 58,
  targetEnd: 68,
  sentenceText: "It is a truth universally acknowledged, that a single man in want of a wife.",
  bookTitle: "Pride and Prejudice",
  back: { kind: "phrase", meaning: "需要；缺少", usage: "be in want of sth，偏书面", example: "The old house is in want of repair." },
  due: inDays(1),
};

const deliberately: CardListItem = {
  ...base,
  id: "k3",
  sentenceId: "s3",
  bookId: "b2",
  targetText: "deliberately",
  targetKind: "word",
  targetStart: 45,
  targetEnd: 57,
  sentenceText: "I went to the woods because I wished to live deliberately.",
  bookTitle: "Walden",
  back: null,
  due: inDays(12),
};

const fiveHundred: CardListItem = {
  ...base,
  id: "k4",
  sentenceId: null,
  bookId: null,
  targetText: "five hundred a year",
  targetKind: "phrase",
  targetStart: 18,
  targetEnd: 37,
  sentenceText: "A woman must have five hundred a year.",
  bookTitle: "A Room of One’s Own",
  back: { kind: "phrase", meaning: "每年五百镑的收入", usage: "", example: "" },
  due: inDays(40),
};

let cards: CardListItem[];
let requests: string[];
let backFails: boolean;

beforeEach(() => {
  stubMediaPlayback();
  cards = [granted, inWantOf, deliberately, fiveHundred];
  requests = [];
  backFails = false;
  window.history.pushState(null, "", "/cards");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app", playGuideSeen: true });
      if (url === "/api/gleanings/count") return Response.json({ count: 0 });
      if (url === "/api/cards" && method === "GET") return Response.json(cards);
      const back = /^\/api\/cards\/([^/]+)\/back$/.exec(url);
      if (back && method === "POST") {
        if (backFails) return Response.json({ error: { code: "card_back_failed", message: "释义生成失败，点击重试" } }, { status: 502 });
        const card = cards.find((c) => c.id === back[1])!;
        const { bookId: _, ...rest } = card;
        const regenerated: Card = { ...rest, back: { kind: "word", meaning: "新的释义", phonetic: "", partOfSpeech: "", collocations: [] } };
        return Response.json(regenerated);
      }
      const del = /^\/api\/cards\/([^/]+)$/.exec(url);
      if (del && method === "DELETE") {
        cards = cards.filter((c) => c.id !== del[1]);
        return new Response(null, { status: 204 });
      }
      return new Promise<Response>(() => {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

async function openPage() {
  render(<App />);
  await screen.findByRole("heading", { name: /卡片/ });
  await screen.findByRole("list", { name: "卡片列表" });
}

const list = () => screen.getByRole("list", { name: "卡片列表" });
const rows = () => within(list()).queryAllByRole("button").map((b) => b.querySelector(".card-item-target")?.textContent);
const detail = () => screen.queryByRole("complementary", { name: "卡片详情" });

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

async function search(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索卡片" }), { target: { value: text } });
  });
}

async function openCard(target: string) {
  await click(within(list()).getByText(target, { selector: ".card-item-target" }).closest("button")!);
  return detail()!;
}

describe("卡片列表 (F14)", () => {
  it("is the 卡片 entry of the navigation, listing Target, meaning, source and next Review", async () => {
    window.history.pushState(null, "", "/");
    render(<App />);
    const entry = await screen.findByRole("link", { name: "卡片" });
    await click(entry);

    await screen.findByRole("list", { name: "卡片列表" });
    expect(window.location.pathname).toBe("/cards");
    expect(screen.getByRole("link", { name: "卡片" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: /卡片/ }).textContent).toContain("4");
    expect(rows()).toEqual(["granted", "in want of", "deliberately", "five hundred a year"]);
    const first = within(list()).getAllByRole("button")[0]!;
    expect(first.textContent).toContain("理所当然的");
    expect(first.textContent).toContain("Pride and Prejudice");
    expect(first.querySelector(".card-item-due")!.textContent).toBe("今天");
    const all = within(list()).getAllByRole("button");
    expect(all[1]!.querySelector(".card-item-due")!.textContent).toBe("明天");
    expect(all[2]!.querySelector(".card-item-due")!.textContent).toBe("12 天后");
    // No back yet: the list says so where the meaning goes.
    expect(all[2]!.textContent).toContain("释义生成失败");
  });

  it("searches the Target and the Sentence, ignoring case (AC-CLIST-01)", async () => {
    await openPage();

    await search("GRANTED");
    expect(rows()).toEqual(["granted"]);

    // Only in the Sentence, not the Target.
    await search("woods");
    expect(rows()).toEqual(["deliberately"]);

    await search("zebra");
    expect(rows()).toEqual([]);
    expect(screen.getByText("没有找到匹配的卡片")).toBeTruthy();

    await search("");
    expect(rows()).toHaveLength(4);
  });

  it("filters by Book, a deleted Book's Cards under its own chip; search narrows the filtered list", async () => {
    await openPage();
    const filter = screen.getByRole("group", { name: "按书筛选" });
    expect(within(filter).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "全部",
      "Pride and Prejudice",
      "Walden",
      "A Room of One’s Own（已删除）",
    ]);

    await click(within(filter).getByRole("button", { name: "Pride and Prejudice" }));
    expect(rows()).toEqual(["granted", "in want of"]);
    await search("want");
    expect(rows()).toEqual(["in want of"]);

    await search("");
    await click(within(filter).getByRole("button", { name: "A Room of One’s Own（已删除）" }));
    expect(rows()).toEqual(["five hundred a year"]);

    await click(within(filter).getByRole("button", { name: "全部" }));
    expect(rows()).toHaveLength(4);
  });

  it("says so when there are no Cards yet", async () => {
    cards = [];
    render(<App />);
    expect(await screen.findByText(/还没有卡片/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "按书筛选" })).toBeNull();
  });
});

describe("a Card's detail", () => {
  it("shows the Sentence with the Target, the back, kind and next Review; X closes it", async () => {
    await openPage();
    expect(detail()).toBeNull();

    const panel = await openCard("in want of");

    expect(within(panel).getByText("短语")).toBeTruthy();
    expect(within(panel).getByText("明天复习")).toBeTruthy();
    expect(within(panel).getByText("Pride and Prejudice")).toBeTruthy();
    expect(panel.querySelector("mark")!.textContent).toBe("in want of");
    expect(within(panel).getByText("需要；缺少")).toBeTruthy();
    expect(within(panel).getByText("be in want of sth，偏书面")).toBeTruthy();
    expect(within(panel).getByText("The old house is in want of repair.")).toBeTruthy();
    expect(within(list()).getByText("in want of", { selector: ".card-item-target" }).closest("button")!.getAttribute("aria-pressed")).toBe("true");

    await click(within(panel).getByRole("button", { name: "关闭卡片详情" }));
    expect(detail()).toBeNull();
  });

  it("plays the Card's own audio (卡片原声)", async () => {
    await openPage();
    const panel = await openCard("granted");

    await click(within(panel).getByRole("button", { name: "卡片原声" }));

    const clip = [...document.querySelectorAll("audio")].find((a) => a.getAttribute("src") === "/api/cards/k1/audio");
    expect(clip).toBeTruthy();
    expect(clip!.paused).toBe(false);
  });

  it("shows 【来源：《书名》（已删除）】 for a Card whose Book is gone, and still plays it (AC-CLIST-03)", async () => {
    await openPage();
    expect(within(list()).getByText("A Room of One’s Own（已删除）")).toBeTruthy();

    const panel = await openCard("five hundred a year");

    expect(within(panel).getByText("来源：《A Room of One’s Own》（已删除）")).toBeTruthy();
    await click(within(panel).getByRole("button", { name: "卡片原声" }));
    const clip = [...document.querySelectorAll("audio")].find((a) => a.getAttribute("src") === "/api/cards/k4/audio");
    expect(clip!.paused).toBe(false);
  });

  it("generates the back again with 【重新生成】, the next Review unchanged (AC-CLIST-04)", async () => {
    await openPage();
    const panel = await openCard("granted");
    expect(within(panel).getByText("理所当然的")).toBeTruthy();

    await click(within(panel).getByRole("button", { name: "重新生成" }));

    expect(requests).toContain("POST /api/cards/k1/back");
    expect(await within(panel).findByText("新的释义")).toBeTruthy();
    expect(within(panel).getByText("今天复习")).toBeTruthy();
    // The list follows; the Card keeps its source.
    const row = within(list()).getByText("granted", { selector: ".card-item-target" }).closest("button")!;
    expect(row.textContent).toContain("新的释义");
    expect(row.textContent).toContain("Pride and Prejudice");
  });

  it("keeps the old back when generating it again fails", async () => {
    backFails = true;
    await openPage();
    const panel = await openCard("granted");

    await click(within(panel).getByRole("button", { name: "重新生成" }));

    expect((await within(panel).findByRole("alert")).textContent).toBe("重新生成失败，请稍后再试");
    expect(within(panel).getByText("理所当然的")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "重新生成" })).toBeEnabled();
  });

  it("offers 【释义生成失败，点击重试】 on a Card without a back", async () => {
    await openPage();
    const panel = await openCard("deliberately");

    await click(within(panel).getByRole("button", { name: "释义生成失败，点击重试" }));

    expect(await within(panel).findByText("新的释义")).toBeTruthy();
  });
});

describe("deleting a Card (PRD 4.5.2 删除, AC-CLIST-02)", () => {
  it("asks first; 取消 keeps the Card", async () => {
    await openPage();
    const panel = await openCard("granted");

    await click(within(panel).getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("alertdialog", { name: "删除这张卡片？" });
    expect(dialog.textContent).toContain("删除后不可恢复");

    await click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(rows()).toContain("granted");
  });

  it("deletes it once confirmed: gone from the list and the detail closes", async () => {
    await openPage();
    const panel = await openCard("granted");

    await click(within(panel).getByRole("button", { name: "删除" }));
    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));

    expect(requests).toContain("DELETE /api/cards/k1");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(detail()).toBeNull();
    expect(rows()).toEqual(["in want of", "deliberately", "five hundred a year"]);
    expect(screen.getByRole("heading", { name: /卡片/ }).textContent).toContain("3");
  });

  it("drops the chip of a Book whose last Card was deleted", async () => {
    await openPage();
    await click(within(screen.getByRole("group", { name: "按书筛选" })).getByRole("button", { name: "Walden" }));
    const panel = await openCard("deliberately");

    await click(within(panel).getByRole("button", { name: "删除" }));
    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));

    const filter = screen.getByRole("group", { name: "按书筛选" });
    expect(within(filter).queryByRole("button", { name: "Walden" })).toBeNull();
    expect(within(filter).getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe("true");
    expect(rows()).toHaveLength(3);
  });
});
