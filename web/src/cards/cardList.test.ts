import { describe, expect, it } from "vitest";
import type { CardListItem } from "../api";
import { cardSources, matchesSearch, sourceDetail, sourceLabel } from "./cardList";

const card = (over: Partial<CardListItem>): CardListItem => ({
  id: "k1",
  sentenceId: "s1",
  bookId: "b1",
  targetText: "granted",
  targetKind: "word",
  targetStart: 16,
  targetEnd: 23,
  sentenceText: "She took it for granted that he would come.",
  contextBefore: null,
  contextAfter: null,
  bookTitle: "Pride and Prejudice",
  back: null,
  hasAudio: true,
  due: "2026-11-18T00:00:00.000Z",
  createdAt: "2026-11-18T00:00:00.000Z",
  ...over,
});

describe("matchesSearch (AC-CLIST-01)", () => {
  it("matches the Target or the Sentence, ignoring case and surrounding spaces", () => {
    expect(matchesSearch(card({}), "GRANTED")).toBe(true);
    expect(matchesSearch(card({ targetText: "come" }), " Granted ")).toBe(true);
    expect(matchesSearch(card({ targetText: "Took It" }), "took it")).toBe(true);
    expect(matchesSearch(card({}), "bakery")).toBe(false);
  });

  it("matches everything with a blank query", () => {
    expect(matchesSearch(card({}), "")).toBe(true);
    expect(matchesSearch(card({}), "   ")).toBe(true);
  });
});

describe("sources", () => {
  it("names a deleted Book's source as deleted, in the list and the detail (AC-CLIST-03)", () => {
    const gone = card({ bookId: null, sentenceId: null, bookTitle: "A Room of One’s Own" });
    expect(sourceLabel(gone)).toBe("A Room of One’s Own（已删除）");
    expect(sourceDetail(gone)).toBe("来源：《A Room of One’s Own》（已删除）");
    expect(sourceLabel(card({}))).toBe("Pride and Prejudice");
    expect(sourceDetail(card({}))).toBe("Pride and Prejudice");
  });

  it("offers each source once, in the order its first Card comes; a deleted Book's Cards share one", () => {
    const sources = cardSources([
      card({ id: "a", bookId: "b2", bookTitle: "Walden" }),
      card({ id: "b" }),
      card({ id: "c", bookId: "b2", bookTitle: "Walden" }),
      card({ id: "d", bookId: null, bookTitle: "Walden" }),
      card({ id: "e", bookId: null, bookTitle: "Walden" }),
    ]);
    expect(sources).toEqual([
      { key: "b2", label: "Walden" },
      { key: "b1", label: "Pride and Prejudice" },
      { key: "deleted:Walden", label: "Walden（已删除）" },
    ]);
  });
});
