// The Mark outbox (PRD F8 异常处理): Marks that could not reach the API wait per user and go out later.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushOutbox, markSentence, startOutbox, stopOutbox, withQueued } from "./marks";

let reachable: boolean;
let sent: string[];

beforeEach(() => {
  reachable = false;
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/gleanings/count") return Response.json({ count: 0 });
      if (!reachable) throw new TypeError("Failed to fetch");
      sent.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/missing/mark")) return Response.json({ error: { code: "not_found", message: "句子不存在" } }, { status: 404 });
      return Response.json({ result: "created" });
    }),
  );
});

afterEach(async () => {
  stopOutbox();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the Mark outbox", () => {
  it("tries again a little later when the API was unreachable but the browser never went offline", async () => {
    vi.useFakeTimers();
    startOutbox("u1");
    expect(await markSentence("s1")).toBe("queued");

    reachable = true;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sent).toEqual(["PUT /api/sentences/s1/mark"]);
    expect(withQueued([])).toEqual(new Set());
  });

  it("keeps each user's queued Marks to that user", async () => {
    startOutbox("u1");
    await markSentence("s1");
    stopOutbox();

    startOutbox("u2");
    expect(withQueued([])).toEqual(new Set());
    reachable = true;
    await flushOutbox();
    expect(sent).toEqual([]);

    stopOutbox();
    startOutbox("u1");
    await flushOutbox();
    expect(sent).toEqual(["PUT /api/sentences/s1/mark"]);
  });

  it("drops a queued Mark the API refuses, without trying it again", async () => {
    startOutbox("u1");
    await markSentence("missing");
    await markSentence("s2");
    reachable = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await flushOutbox();
    await flushOutbox();

    expect(sent).toEqual(["PUT /api/sentences/missing/mark", "PUT /api/sentences/s2/mark"]);
  });
});
