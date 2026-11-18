// Parsing quality and 解析失败 through the running stack, from the user's side (#3): upload the sample EPUBs in
// fixtures/ (built by worker/tests/sample_epubs.py, one per rule) and read back what the user gets.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Sentence } from "../api/src/contract.js";
import { api, endOpenJobs, upload, waitWhileParsing } from "./support.js";

// Generating the Books' audio is not under test here; keep the worker free for the next upload's parse.
afterEach(() => endOpenJobs());

const sample = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

async function parsed(name: string) {
  const created = await upload(name, sample(name));
  expect(created.status).toBe(201);
  return waitWhileParsing(created.body.id);
}

describe("an EPUB with front and back matter (AC-UP-06 to AC-UP-09)", () => {
  it("keeps every Chapter but narrates only the Preface and the body", async () => {
    const book = await parsed("parse-rules.epub");

    expect(book).toMatchObject({ title: "A Study in Rules", status: "generating" });
    // Each Skipped by one rule of PRD 4.2.5: epub:type, landmarks, short text, title; Index and Endnotes by several.
    expect(book.chapters.map((c) => [c.title, c.skipped])).toEqual([
      ["Rights", true],
      ["Map of the Book", true],
      ["Dedication", true],
      ["Preface", false],
      ["Chapter I", false],
      ["Acknowledgments", true],
      ["Index", true],
      ["Endnotes", true],
    ]);
    // Skipped Chapters are never queued for audio (PRD 4.3.3).
    expect(book.chapters.filter((c) => c.skipped).every((c) => c.audioStatus === "pending")).toBe(true);
  });

  it("splits Sentences by the rules and reads numbers as words without note numbers", async () => {
    const book = await parsed("parse-rules.epub");
    const chapterOne = book.chapters.find((c) => c.title === "Chapter I")!;

    const { body: sentences } = await api<Sentence[]>(`/chapters/${chapterOne.id}/sentences`);

    expect(sentences.slice(0, 4).map((s) => [s.text, s.spokenText])).toEqual([
      ["“Come in,” Mr. Holmes said.", "“Come in,” Mr. Holmes said."],
      ["“You have come 200 miles, I perceive.”", "“You have come two hundred miles, I perceive.”"],
      ["It was the 3rd of March, and the fog was thick.", "It was the third of March, and the fog was thick."],
      ["Dr. Watson agreed.", "Dr. Watson agreed."],
    ]);
    expect(sentences.some((s) => s.text.includes("footnote"))).toBe(false);
    // Each over-long Sentence becomes several within 300 characters (PRD 4.2.6 rule 2, 4.7.2): one split at
    // semicolons, one at commas.
    for (const [paragraph, mark] of [[2, ";"], [3, ","]] as const) {
      const pieces = sentences.filter((s) => s.paragraphIndex === paragraph).map((s) => s.text);
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.every((p) => p.length <= 300)).toBe(true);
      expect(pieces.slice(0, -1).every((p) => p.endsWith(mark))).toBe(true);
    }
  });
});

describe("an EPUB that cannot be turned into audio ends 解析失败 with its reason (PRD 4.3.5)", () => {
  it.each([
    ["drm.epub", "该文件受 DRM 保护，无法转换。请使用无 DRM 的 EPUB"],
    ["corrupt.epub", "文件无法读取，可能已损坏"],
    ["no-text.epub", "没有识别到可朗读的正文"],
  ])("%s", async (name, reason) => {
    const book = await parsed(name);

    expect(book).toMatchObject({ status: "parse_failed", failureReason: reason, playable: false, chapters: [] });
    // Final: it is never parsed again (PRD 4.3.3 invariant 4).
    await new Promise((r) => setTimeout(r, 1500));
    expect((await api(`/books/${book.id}`)).body).toMatchObject({ status: "parse_failed", failureReason: reason });
  });
});
