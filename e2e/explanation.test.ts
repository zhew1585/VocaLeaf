// End-to-end: 句子精读's AI (#14) on the running compose stack. Without ANTHROPIC_API_KEY the API answers with its
// deterministic fake (ADR 0003), which this test relies on. Needs `npm run e2e:up`.
import { beforeEach, describe, expect, it } from "vitest";
import type { BookDetail, ExplainEvent, Explanation, Sentence } from "../api/src/contract.js";
import { BASE, endOpenJobs, newUser, sessionCookie, SHORT_WALK, sql } from "./support.js";

beforeEach(() => endOpenJobs());

/** A fresh user with a parsed Book, and one of its Sentences. */
async function userWithSentence(label: string) {
  const user = await newUser(label);
  const created = await user.upload("short-walk.epub", SHORT_WALK);
  expect(created.status).toBe(201);
  // Polled as its uploader: the Book is private to them.
  let book = (await user.api<BookDetail>(`/books/${created.body.id}`)).body;
  for (const deadline = Date.now() + 60_000; book.status === "parsing" && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 500));
    book = (await user.api<BookDetail>(`/books/${created.body.id}`)).body;
  }
  const chapter = book.chapters.find((c) => !c.skipped)!;
  const [sentence] = (await user.api<Sentence[]>(`/chapters/${chapter.id}/sentences`)).body;
  return { ...user, sentence: sentence! };
}

function post(cookie: string, sentenceId: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${BASE}/api/sentences/${sentenceId}/explanation`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function events(res: Response): Promise<ExplainEvent[]> {
  expect(res.status).toBe(200);
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ExplainEvent);
}

describe("Explanations through the stack", () => {
  it("streams an Explanation through nginx, keeps it, and answers follow-ups in the same context", async () => {
    const u = await userWithSentence("explain");

    const explained = await events(await post(u.cookie, u.sentence.id, { kind: "explain" }));
    expect(explained.filter((e) => e.type === "delta").length).toBeGreaterThan(1);
    expect(explained.at(-1)).toEqual({ type: "done", aiRemaining: 99 });

    const asked = await events(await post(u.cookie, u.sentence.id, { kind: "ask", question: "这句话是什么意思？" }));
    expect(asked.at(-1)).toEqual({ type: "done", aiRemaining: 98 });

    const { body } = await u.api<Explanation>(`/sentences/${u.sentence.id}/explanation`);
    expect(body.content).toContain("## 句意");
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(body.aiRemaining).toBe(98);
  });

  it("does not count a failed call, and counts a stopped one without keeping it", async () => {
    const u = await userWithSentence("explain-fail");

    const failed = await events(await post(u.cookie, u.sentence.id, { kind: "ask", question: "#fail" }));
    expect(failed.at(-1)).toEqual({ type: "error", message: "解析失败，请重试" });
    expect((await u.api<Explanation>(`/sentences/${u.sentence.id}/explanation`)).body.aiRemaining).toBe(100);

    const stop = new AbortController();
    const res = await post(u.cookie, u.sentence.id, { kind: "explain" }, stop.signal);
    await res.body!.getReader().read();
    stop.abort();
    let after: Explanation | undefined;
    for (let i = 0; i < 50; i++) {
      after = (await u.api<Explanation>(`/sentences/${u.sentence.id}/explanation`)).body;
      if (after.aiRemaining === 99) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(after).toMatchObject({ content: null, aiRemaining: 99 });
  });

  it("refuses calls once the day's 100 are used, and keeps Explanations private to their user", async () => {
    const u = await userWithSentence("explain-limit");
    sql(
      `insert into ai_usage (user_id, day, count) select id, (now() at time zone 'Asia/Shanghai')::date, 100 from users where email = '${u.email}'`,
    );

    const refused = await post(u.cookie, u.sentence.id, { kind: "explain" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "ai_quota_exhausted", message: "今日 AI 解析次数已用完，明天再来" } });

    const other = await fetch(`${BASE}/api/sentences/${u.sentence.id}/explanation`, { headers: { Cookie: await sessionCookie() } });
    expect(other.status).toBe(404);
  });
});
