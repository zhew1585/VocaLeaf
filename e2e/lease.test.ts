// End-to-end: a worker that dies holding a parse job must not strand the Book.
// Needs the stack started with a short lease: `npm run e2e:up` (JOB_LEASE_SECONDS=5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BookDetail, ClaimedJob } from "../api/src/contract.js";
import { asWorker, compose, LEASE_SECONDS, PRIDE_AND_PREJUDICE, upload, waitWhileParsing } from "./support.js";

const RECOVERY_MS = (LEASE_SECONDS + 30) * 1000;

async function waitForWorkerLog(line: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!compose("logs", "worker").includes(line)) {
    if (Date.now() > deadline) throw new Error(`worker never logged: ${line}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function expectParsed(book: BookDetail) {
  expect(book.status, "is the stack running with a short lease? use `npm run e2e:up`").toBe("generating");
  expect(book.chapters).toHaveLength(65);
  expect(book.chapters.slice(2, 63).every((c) => c.sentenceCount > 0)).toBe(true);
}

describe("restarting the worker while it parses", () => {
  // Safety net when the test fails while storage is paused; unpausing a running container throws.
  afterAll(() => {
    if (compose("ps", "--status", "paused", "--services").includes("storage")) compose("unpause", "storage");
  });

  it("re-claims the job after the lease and still ends with the Book parsed", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    const claimedBy = (attempt: number) => `parse book ${created.body.id} (attempt ${attempt})`;
    // Freeze object storage so the worker that claims the job hangs while fetching the EPUB.
    compose("pause", "storage");
    await waitForWorkerLog(claimedBy(1));

    compose("restart", "-t", "0", "worker");
    compose("unpause", "storage");

    expectParsed(await waitWhileParsing(created.body.id, RECOVERY_MS));
    expect(compose("logs", "worker")).toContain(claimedBy(2));
  });
});

describe("with the worker stopped", () => {
  beforeAll(() => {
    compose("stop", "-t", "0", "worker");
  });
  afterAll(() => {
    compose("start", "worker");
  });

  it("hands a job to exactly one of many concurrent claimers (real Postgres)", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);

    const claims = await Promise.all(Array.from({ length: 10 }, () => asWorker<ClaimedJob | null>("/jobs/claim")));
    const won = claims.filter((c) => c.status === 200);

    expect(won).toHaveLength(1);
    expect(won[0]!.body).toMatchObject({ bookId: created.body.id, attempt: 1 });
    expect(claims.filter((c) => c.status === 204)).toHaveLength(9);
  });

  it("recovers a job whose worker died: the next worker re-claims it after the lease and finishes the Book", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    // Stand-in for a worker that claims the job and dies before reporting.
    const dead = (await asWorker<ClaimedJob>("/jobs/claim")).body;
    expect(dead.bookId).toBe(created.body.id);

    compose("start", "worker");
    const book = await waitWhileParsing(created.body.id, RECOVERY_MS);
    expectParsed(book);

    // The dead worker's late report is refused and changes nothing.
    const late = await asWorker(`/jobs/${dead.id}/parse-result`, {
      attempt: dead.attempt,
      parserVersion: "stale",
      title: "Stale",
      author: null,
      chapters: [{ title: "Stale", sentences: [] }],
    });
    expect(late.status).toBe(409);
    const after = await waitWhileParsing(created.body.id);
    expect(after).toEqual(book);
  });
});
