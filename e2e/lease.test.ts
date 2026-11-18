// End-to-end: a worker that dies holding a parse job must not strand the Book.
// Needs the stack started with a short lease: `npm run e2e:up` (JOB_LEASE_SECONDS=5).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BookDetail, ClaimedJob } from "../api/src/contract.js";
import {
  asWorker,
  compose,
  endOpenJobs,
  LEASE_SECONDS,
  PRIDE_AND_PREJUDICE,
  upload,
  waitWhileParsing,
} from "./support.js";

const RECOVERY_MS = (LEASE_SECONDS + 30) * 1000;

/** Starts only the worker; `compose start` would also start its dependencies, which fails while storage is paused. */
function startWorker() {
  compose("up", "-d", "--no-deps", "worker");
}

async function waitForWorkerLog(line: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!compose("logs", "worker").includes(line)) {
    if (Date.now() > deadline) throw new Error(`worker never logged: ${line}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** What parsing decided; audio fields keep changing while the worker generates the Book. */
function parsedPart(book: BookDetail) {
  return { title: book.title, author: book.author, chapters: book.chapters.map((c) => [c.id, c.title, c.sentenceCount]) };
}

// Each test here uploads Pride and Prejudice, which then generates for hours. Without this, a recovering
// job would wait behind whatever long Chapter the worker picked up from the previous test.
beforeEach(() => endOpenJobs());
afterAll(() => endOpenJobs());

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
    // Upload with the worker stopped, then freeze object storage before it starts:
    // the worker claims the job and hangs fetching the EPUB, so the restart lands mid-job.
    compose("stop", "-t", "0", "worker");
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    const claimedBy = (attempt: number) => `parse book ${created.body.id} (attempt ${attempt})`;
    compose("pause", "storage");
    startWorker();
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
    startWorker();
  });

  it("hands a job to exactly one of many concurrent claimers (real Postgres)", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);

    const claims = await Promise.all(Array.from({ length: 10 }, () => asWorker<ClaimedJob | null>("/jobs/claim")));
    const won = claims.filter((c) => c.status === 200).map((c) => c.body!);

    expect(new Set(won.map((j) => j.id)).size).toBe(won.length);
    expect(won.filter((j) => j.bookId === created.body.id)).toMatchObject([{ attempt: 1 }]);

    // Close every claimed job so no lease expires into the next test's claim.
    for (const job of won) {
      expect((await asWorker(`/jobs/${job.id}/failure`, { attempt: job.attempt, error: "e2e cleanup" })).status).toBe(204);
    }
  });

  it("recovers a job whose worker died: the next worker re-claims it after the lease and finishes the Book", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    // Stand-in for a worker that claims the job and dies before reporting.
    const dead = (await asWorker<ClaimedJob>("/jobs/claim")).body;
    expect(dead.bookId).toBe(created.body.id);

    startWorker();
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
    expect(parsedPart(after)).toEqual(parsedPart(book));
  });
});
