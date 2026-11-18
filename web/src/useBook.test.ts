import { describe, expect, it } from "vitest";
import type { BookDetail } from "./api";
import { nextPollMs } from "./useBook";

const book = (status: BookDetail["status"], playable: boolean) => ({ status, playable }) as BookDetail;

describe("nextPollMs", () => {
  it("checks often while the user waits for parsing or the first audio", () => {
    expect(nextPollMs(book("parsing", false))).toBe(1500);
    expect(nextPollMs(book("generating", false))).toBe(1500);
  });

  it("checks now and then while a playable Book keeps generating, so 已就绪 shows without a reload", () => {
    expect(nextPollMs(book("generating", true))).toBe(15_000);
  });

  it("stops once the Book is ready or failed, with or without audio", () => {
    expect(nextPollMs(book("ready", true))).toBeNull();
    expect(nextPollMs(book("ready", false))).toBeNull();
    expect(nextPollMs(book("parse_failed", false))).toBeNull();
  });
});
