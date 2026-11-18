// Job claims, leases and endings, shared by every job type.
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books, chapters, jobs } from "../db/schema.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Job = typeof jobs.$inferSelect;

/** PRD 4.3.1 and 4.7.2: a job is attempted at most 3 times. */
const MAX_JOB_ATTEMPTS = 3;

// Temporary user-facing text until #5 brings the full timeout and retry handling (PRD 4.3.5 #10).
const LEASE_EXHAUSTED_REASON = "解析超时，请删除后重新上传";

/**
 * Locks the job if it is still running under the given attempt. `attempt` is the fencing token:
 * once a job is claimed again (attempt + 1), finished or failed, reports from older claims are refused.
 * A report that arrives after its lease ran out is still accepted if nobody claimed the job since.
 */
export async function lockCurrentAttempt(tx: Tx, id: string, attempt: number): Promise<Job | undefined> {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.attempt, attempt)))
    .for("update");
  return job;
}

/** Extends the lease of a running claim: the worker is alive and still working on it. */
export async function renewLease(tx: Tx, job: Job, now: Date, leaseMs: number) {
  await tx
    .update(jobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(eq(jobs.id, job.id));
}

/** Ends a job as succeeded. */
export async function succeedJob(tx: Tx, job: Job, now: Date) {
  await tx.update(jobs).set({ status: "succeeded", leaseExpiresAt: null, updatedAt: now }).where(eq(jobs.id, job.id));
}

/**
 * Marks a job failed. A failed parse job leaves its Book parse_failed; a failed render job leaves its
 * Chapter 生成失败 and the Book carries on (PRD 4.3.5 #9). Retrying a failed Chapter comes with #5.
 */
export async function failJob(tx: Tx, job: Job, error: string, now: Date, reason: string | null = null) {
  await tx.update(jobs).set({ status: "failed", error, leaseExpiresAt: null, updatedAt: now }).where(eq(jobs.id, job.id));
  if (job.type === "parse") {
    await tx.update(books).set({ status: "parse_failed", failureReason: reason }).where(eq(books.id, job.bookId));
  } else {
    await tx.update(chapters).set({ audioStatus: "failed" }).where(eq(chapters.id, job.chapterId!));
    await finishBookIfDone(tx, job.bookId);
  }
}

/**
 * Moves a generating Book to ready once every narrated Chapter is generated or failed (PRD 4.3.3 invariant 1).
 */
export async function finishBookIfDone(tx: Tx, bookId: string) {
  const [open] = await tx
    .select({ id: chapters.id })
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        eq(chapters.skipped, false),
        inArray(chapters.audioStatus, ["pending", "generating"]),
      ),
    )
    .limit(1);
  if (open) return;
  await tx
    .update(books)
    .set({ status: "ready" })
    .where(and(eq(books.id, bookId), eq(books.status, "generating")));
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
    await failJob(tx, job, `lease expired on attempt ${job.attempt} of ${MAX_JOB_ATTEMPTS}`, now, LEASE_EXHAUSTED_REASON);
  }
}

/**
 * Claims the next job that is queued, or running with an expired lease and attempts left: lowest position
 * first (every Book's parse, then every Book's first narrated Chapter, ...), oldest first within a position.
 * SKIP LOCKED keeps concurrent claims from handing one job to two workers.
 */
export async function claimNextJob(tx: Tx, now: Date, leaseMs: number): Promise<Job | undefined> {
  await failExhaustedJobs(tx, now);
  const [next] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(or(eq(jobs.status, "queued"), and(leaseExpired(now), lt(jobs.attempt, MAX_JOB_ATTEMPTS))))
    .orderBy(asc(jobs.position), asc(jobs.createdAt), asc(jobs.id))
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
