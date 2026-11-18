import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { bearerAuth } from "hono/bearer-auth";
import type { AppDeps } from "../app.js";
import {
  ClaimedJobSchema,
  ErrorSchema,
  JobFailureSchema,
  ParseResultSchema,
  type ParseResult,
} from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, jobs, sentences } from "../db/schema.js";
import { sourceKey } from "../storage.js";
import { validationHook } from "../validation.js";

const security = [{ workerToken: [] }];
const jobParams = z.object({ id: z.uuid() });
const jobNotRunning = {
  error: { code: "job_not_running", message: "Job is not running under this attempt" },
} as const;
const conflict = {
  description: "Job is not running under this attempt: finished, failed, or claimed again since",
  content: { "application/json": { schema: ErrorSchema } },
};

const claimRoute = createRoute({
  method: "post",
  path: "/internal/jobs/claim",
  summary: "Worker claims the oldest queued job",
  security,
  responses: {
    200: { description: "Claimed job", content: { "application/json": { schema: ClaimedJobSchema } } },
    204: { description: "No job queued" },
  },
});

const parseResultRoute = createRoute({
  method: "post",
  path: "/internal/jobs/{id}/parse-result",
  summary: "Worker reports the Chapters and Sentences of a parsed Book",
  security,
  request: {
    params: jobParams,
    body: { required: true, content: { "application/json": { schema: ParseResultSchema } } },
  },
  responses: { 204: { description: "Stored" }, 409: conflict },
});

const failureRoute = createRoute({
  method: "post",
  path: "/internal/jobs/{id}/failure",
  summary: "Worker reports that a job failed",
  security,
  request: {
    params: jobParams,
    body: { required: true, content: { "application/json": { schema: JobFailureSchema } } },
  },
  responses: { 204: { description: "Recorded" }, 409: conflict },
});

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Job = typeof jobs.$inferSelect;

/** PRD 4.3.1 and 4.7.2: a job is attempted at most 3 times. */
const MAX_JOB_ATTEMPTS = 3;

// Temporary user-facing text until #5 brings the full timeout and retry handling (PRD 4.3.5 #10).
const LEASE_EXHAUSTED_REASON = "解析超时，请删除后重新上传";

/** Postgres caps bind parameters at 65535 per statement; 6 columns per sentence row. */
const SENTENCE_INSERT_BATCH = 5000;

/**
 * Locks the job if it is still running under the given attempt. `attempt` is the fencing token:
 * once a job is claimed again (attempt + 1), finished or failed, reports from older claims are refused.
 * A report that arrives after its lease ran out is still accepted if nobody claimed the job since.
 */
async function lockCurrentAttempt(tx: Tx, id: string, attempt: number): Promise<Job | undefined> {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.attempt, attempt)))
    .for("update");
  return job;
}

/** Marks a job failed; a failed parse job leaves its Book parse_failed. */
async function failJob(tx: Tx, job: Job, error: string, reason: string | null, now: Date) {
  await tx.update(jobs).set({ status: "failed", error, leaseExpiresAt: null, updatedAt: now }).where(eq(jobs.id, job.id));
  if (job.type === "parse") {
    await tx.update(books).set({ status: "parse_failed", failureReason: reason }).where(eq(books.id, job.bookId));
  }
}

/** A running job whose worker may be gone. A missing lease (jobs claimed before leases existed) counts as expired. */
function leaseExpired(now: Date) {
  return and(eq(jobs.status, "running"), or(isNull(jobs.leaseExpiresAt), lt(jobs.leaseExpiresAt, now)));
}

/**
 * Running jobs whose lease ran out on their last allowed attempt are failed instead of handed out again.
 * This happens lazily inside a claim: with no worker polling, nothing could recover the job anyway.
 */
async function failExhaustedJobs(tx: Tx, now: Date) {
  const exhausted = await tx
    .select()
    .from(jobs)
    .where(and(leaseExpired(now), gte(jobs.attempt, MAX_JOB_ATTEMPTS)))
    .for("update", { skipLocked: true });
  for (const job of exhausted) {
    await failJob(tx, job, `lease expired on attempt ${job.attempt} of ${MAX_JOB_ATTEMPTS}`, LEASE_EXHAUSTED_REASON, now);
  }
}

/**
 * Claims the oldest job that is queued, or running with an expired lease and attempts left.
 * SKIP LOCKED keeps concurrent claims from handing one job to two workers.
 */
async function claimNextJob(tx: Tx, now: Date, leaseMs: number): Promise<Job | undefined> {
  await failExhaustedJobs(tx, now);
  const [next] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      or(eq(jobs.status, "queued"), and(leaseExpired(now), lt(jobs.attempt, MAX_JOB_ATTEMPTS))),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  if (!next) return undefined;
  const [claimed] = await tx
    .update(jobs)
    .set({
      status: "running",
      attempt: sql`${jobs.attempt} + 1`,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(eq(jobs.id, next.id))
    .returning();
  return claimed;
}

/** Saves a parse result; the Book then moves from parsing to generating (PRD 4.3.4 step 3). */
async function storeParseResult(tx: Tx, bookId: string, result: Omit<ParseResult, "attempt">) {
  const inserted = await tx
    .insert(chapters)
    .values(
      result.chapters.map((ch, index) => ({
        bookId,
        index,
        // PRD 4.2.5: a Chapter without a TOC title is named 第 N 章.
        title: ch.title?.trim() || `第 ${index + 1} 章`,
      })),
    )
    .returning({ id: chapters.id, index: chapters.index });

  const rows = inserted.flatMap(({ id, index }) =>
    result.chapters[index]!.sentences.map((s, i) => ({ chapterId: id, index: i, ...s })),
  );
  for (let i = 0; i < rows.length; i += SENTENCE_INSERT_BATCH) {
    await tx.insert(sentences).values(rows.slice(i, i + SENTENCE_INSERT_BATCH));
  }

  await tx
    .update(books)
    .set({
      status: "generating",
      parserVersion: result.parserVersion,
      ...(result.title?.trim() ? { title: result.title.trim() } : {}),
      author: result.author?.trim() || null,
    })
    .where(eq(books.id, bookId));
}

/** Routes the stateless worker uses to pull jobs and report results (ADR 0002, 0003). */
export function jobRoutes({ db, workerToken, jobLeaseMs, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.use("/internal/*", bearerAuth({ token: workerToken }));

  app.openapi(claimRoute, async (c) => {
    const job = await db.transaction((tx) => claimNextJob(tx, now(), jobLeaseMs));
    if (!job) return c.body(null, 204);
    return c.json(
      { id: job.id, type: job.type, bookId: job.bookId, sourceKey: sourceKey(job.bookId), attempt: job.attempt },
      200,
    );
  });

  app.openapi(parseResultRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt, ...result } = c.req.valid("json");
    const stored = await db.transaction(async (tx) => {
      const job = await lockCurrentAttempt(tx, id, attempt);
      if (!job || job.type !== "parse") return false;
      await storeParseResult(tx, job.bookId, result);
      await tx
        .update(jobs)
        .set({ status: "succeeded", leaseExpiresAt: null, updatedAt: now() })
        .where(eq(jobs.id, id));
      return true;
    });
    if (!stored) return c.json(jobNotRunning, 409);
    return c.body(null, 204);
  });

  app.openapi(failureRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt, error } = c.req.valid("json");
    const recorded = await db.transaction(async (tx) => {
      const job = await lockCurrentAttempt(tx, id, attempt);
      if (!job) return false;
      // Failure reasons and their messages (PRD 4.3.5 #4 to #6) come with #3.
      await failJob(tx, job, error, null, now());
      return true;
    });
    if (!recorded) return c.json(jobNotRunning, 409);
    return c.body(null, 204);
  });

  return app;
}
