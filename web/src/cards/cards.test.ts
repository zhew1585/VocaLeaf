// Unit tests of how Cards show in text (PRD 4.4.5 一句多卡) and their labels (F16).
import { describe, expect, it } from "vitest";
import type { Card } from "../api";
import { cardsHit, dueLabel, dueShort, textRuns } from "./cards";

const TEXT = "She took it for granted that he would come.";

const card = (id: string, start: number, end: number): Card => ({
  id,
  sentenceId: "s1",
  targetText: TEXT.slice(start, end),
  targetKind: "phrase",
  targetStart: start,
  targetEnd: end,
  sentenceText: TEXT,
  contextBefore: null,
  contextAfter: null,
  bookTitle: "Pride and Prejudice",
  back: null,
  hasAudio: true,
  due: "2026-11-18T00:00:00.000Z",
  createdAt: "2026-11-18T00:00:00.000Z",
});

describe("textRuns", () => {
  it("is the whole text in one plain run without Cards", () => {
    expect(textRuns(TEXT, [])).toEqual([{ start: 0, end: TEXT.length, text: TEXT, cardIds: [] }]);
  });

  it("underlines each Target on its own, the text between plain (AC-READ-07)", () => {
    const runs = textRuns(TEXT, [card("a", 4, 8), card("b", 16, 23)]);
    expect(runs.map((r) => [r.text, r.cardIds])).toEqual([
      ["She ", []],
      ["took", ["a"]],
      [" it for ", []],
      ["granted", ["b"]],
      [" that he would come.", []],
    ]);
    expect(runs.map((r) => r.text).join("")).toBe(TEXT);
  });

  it("gives a run under a whole-Sentence Card and a phrase Card to both", () => {
    const runs = textRuns(TEXT, [card("whole", 0, TEXT.length), card("b", 16, 23)]);
    expect(runs.map((r) => [r.text, r.cardIds])).toEqual([
      ["She took it for ", ["whole"]],
      ["granted", ["whole", "b"]],
      [" that he would come.", ["whole"]],
    ]);
  });
});

describe("cardsHit", () => {
  const cards = [card("a", 4, 8), card("b", 16, 23)];
  it("is the underline's Cards on an underline, all of the Sentence's elsewhere (AC-POP-01, AC-POP-07)", () => {
    expect(cardsHit(cards, ["b"]).map((c) => c.id)).toEqual(["b"]);
    expect(cardsHit(cards, null).map((c) => c.id)).toEqual(["a", "b"]);
    expect(cardsHit(cards, []).map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("due labels", () => {
  const now = new Date(2026, 10, 19, 15, 0);
  it("count local days", () => {
    expect(dueLabel(new Date(2026, 10, 18, 9).toISOString(), now)).toBe("今天复习");
    expect(dueLabel(new Date(2026, 10, 19, 23).toISOString(), now)).toBe("今天复习");
    expect(dueLabel(new Date(2026, 10, 20, 1).toISOString(), now)).toBe("明天复习");
    expect(dueShort(new Date(2026, 10, 22, 8).toISOString(), now)).toBe("3 天后");
  });

  it("counts in months from 30 days on (design 07: 1 个月后)", () => {
    const now = new Date(2026, 10, 19, 12);
    expect(dueShort(new Date(2026, 11, 18, 8).toISOString(), now)).toBe("29 天后");
    expect(dueShort(new Date(2026, 11, 19, 8).toISOString(), now)).toBe("1 个月后");
    expect(dueShort(new Date(2027, 1, 20, 8).toISOString(), now)).toBe("3 个月后");
    expect(dueLabel(new Date(2027, 0, 1, 8).toISOString(), now)).toBe("1 个月后复习");
  });
});
