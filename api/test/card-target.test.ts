// Unit tests of how a selection becomes a Card's Target (PRD 4.5.2 制卡规则 2, target_kind).
import { describe, expect, it } from "vitest";
import { resolveTarget } from "../src/cards/target.js";

/** The Target a selection of `selected` (its first occurrence) in `text` becomes. */
function select(text: string, selected: string) {
  const start = text.indexOf(selected);
  if (start < 0) throw new Error(`${selected} is not in ${text}`);
  const target = resolveTarget(text, start, start + selected.length);
  return target && { ...target, text: text.slice(target.start, target.end) };
}

const SENTENCE = "She took it for granted that he would come.";

describe("resolveTarget", () => {
  it("widens a selection inside a word to the whole word, a word Target (AC-CARD-01)", () => {
    expect(select(SENTENCE, "grant")).toEqual({ start: 16, end: 23, kind: "word", text: "granted" });
    expect(select(SENTENCE, "ante")).toMatchObject({ kind: "word", text: "granted" });
  });

  it("makes several words a phrase, widening both ends (AC-CARD-02)", () => {
    expect(select(SENTENCE, "ook it for gran")).toMatchObject({ kind: "phrase", text: "took it for granted" });
  });

  it("leaves out spaces and punctuation at the ends", () => {
    expect(select(SENTENCE, " granted that ")).toMatchObject({ kind: "phrase", text: "granted that" });
    expect(select(SENTENCE, "come.")).toMatchObject({ kind: "word", text: "come" });
  });

  it("makes a selection over every word the whole Sentence, punctuation included (AC-CARD-03)", () => {
    const quoted = "“You want to tell me, and I have no objection to hearing it.”";
    expect(select(quoted, "You want to tell me, and I have no objection to hearing it")).toEqual({
      start: 0,
      end: quoted.length,
      kind: "sentence",
      text: quoted,
    });
    expect(select(SENTENCE, "he took it for granted that he would co")).toMatchObject({ kind: "sentence", text: SENTENCE });
  });

  it("keeps apostrophes and hyphens inside words", () => {
    expect(select("I don’t know a well-known man.", "don")).toMatchObject({ kind: "word", text: "don’t" });
    expect(select("I don’t know a well-known man.", "known")).toMatchObject({ kind: "word", text: "well-known" });
  });

  it("refuses a selection without any word, and out-of-range or empty ones", () => {
    expect(resolveTarget(SENTENCE, 3, 4)).toBeNull();
    expect(resolveTarget(SENTENCE, 42, 43)).toBeNull();
    expect(resolveTarget(SENTENCE, 5, 5)).toBeNull();
    expect(resolveTarget(SENTENCE, 9, 3)).toBeNull();
    expect(resolveTarget(SENTENCE, -1, 3)).toBeNull();
    expect(resolveTarget(SENTENCE, 0, 999)).toBeNull();
  });
});
