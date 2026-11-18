import { describe, expect, it } from "vitest";
import type { AudioStatus } from "@vocaleaf/api/contract";
import type { BookDetail } from "./api";
import { nextPollMs } from "./useBook";

const book = (status: BookDetail["status"], playable: boolean, chapters: AudioStatus[] = []) =>
  ({
    status,
    playable,
    chapters: chapters.map((audioStatus) => ({ skipped: false, audioStatus })),
  }) as BookDetail;

describe("nextPollMs", () => {
  it("checks often while the user waits for parsing or the first audio", () => {
    expect(nextPollMs(book("parsing", false))).toBe(1500);
    expect(nextPollMs(book("generating", false))).toBe(1500);
  });

  it("checks every few seconds while a playable Book keeps generating, so its progress stays current", () => {
    expect(nextPollMs(book("generating", true))).toBe(5000);
  });

  it("checks often while the user waits on a Chapter that is not generated yet", () => {
    expect(nextPollMs(book("generating", true), true)).toBe(1500);
  });

  it("keeps checking a 已就绪 Book while a retried Chapter generates again", () => {
    expect(nextPollMs(book("ready", true, ["generated", "pending"]))).toBe(5000);
    expect(nextPollMs(book("ready", true, ["generated", "generating"]))).toBe(5000);
  });

  it("stops once nothing about the Book changes any more, with or without audio", () => {
    expect(nextPollMs(book("ready", true, ["generated", "failed"]))).toBeNull();
    expect(nextPollMs(book("ready", false))).toBeNull();
    expect(nextPollMs(book("parse_failed", false))).toBeNull();
  });
});
