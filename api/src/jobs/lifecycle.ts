// Job claims, leases and endings, shared by every job type.
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ParseFailureReason } from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, jobs } from "../db/schema.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Job = typeof jobs.$inferSelect;

/** PRD 4.3.1 and 4.7.2: a job is attempted at most 3 times, whether its attempts fail or time out. */
export const MAX_JOB_ATTEMPTS = 3;

/** Shown with parse_failed when every parse attempt timed out (PRD 4.3.5 #10). */
const LEASE_EXHAUSTED_REASON = "解析超时，请删除后重新上传";

/** Shown with parse_failed for each reason the worker reports (PRD 4.3.5 #4 to #6). */
const PARSE_FAILURE_MESSAGES: Record<ParseFailureReason, string> = {
  drm: "该文件受 DRM 保护，无法转换。请使用无 DRM 的 EPUB",
  unreadable: "文件无法读取，可能已损坏",
  no_text: "没有识别到可朗读的正文",
};

/**
 * Locks the job if it is still running under the given attempt. `attempt` is the fencing token:
 * once a job is claimed again (attempt + 1), finished or failed, reports from older claims are refused.
 * A report that arrives after its lease ran out is still accepted until a claim puts the job back in the queue.
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
 * A worker reports that its attempt failed. A parse failure with a `reason` is the file's fault (DRM, broken, no
 * text): it fails the same way every time, so the Book is 解析失败 at once and shows why (PRD 4.3.5 #4 to #6).
 * Any other failure (storage, TTS, a bug) goes back to the queue while attempts are left, a Chapter back to
 * 待生成 (PRD 4.3.5 #8); on the last attempt the job fails, and a Book still parsing shows it as unreadable.
 */
export async function failAttempt(tx: Tx, job: Job, error: string, now: Date, reason?: ParseFailureReason) {
  if (job.type === "parse" && reason) await failJob(tx, job, error, now, PARSE_FAILURE_MESSAGES[reason]);
  else if (job.attempt < MAX_JOB_ATTEMPTS) await requeue(tx, job, error, now);
  else await failJob(tx, job, error, now, job.type === "parse" ? PARSE_FAILURE_MESSAGES.unreadable : null);
}

/** Puts a job back in the queue for its next attempt; a Chapter goes back to 待生成. */
async function requeue(tx: Tx, job: Job, error: string, now: Date) {
  await tx
    .update(jobs)
    .set({ status: "queued", error, leaseExpiresAt: null, updatedAt: now })
    .where(eq(jobs.id, job.id));
  if (job.chapterId) await tx.update(chapters).set({ audioStatus: "pending" }).where(eq(chapters.id, job.chapterId));
}

/**
 * Marks a job failed. A failed parse job leaves its Book parse_failed; a failed render job leaves its
 * Chapter 生成失败 and the Book carries on (PRD 4.3.5 #9) until the user retries it (retryFailedChapter).
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
 * The user retries a 生成失败 Chapter (PRD 4.3.5 #9): it goes back to 待生成 with a new job, which again gets
 * every attempt, at the failed job's place in the queue. The Book's status stays: 已就绪 is final (PRD 4.3.3),
 * and a generating Book finishes once this Chapter and the others are done. False when the Chapter is not
 * failed, for example because it was already retried.
 */
export async function retryFailedChapter(tx: Tx, chapterId: string): Promise<boolean> {
  const [chapter] = await tx
    .update(chapters)
    .set({ audioStatus: "pending" })
    .where(and(eq(chapters.id, chapterId), eq(chapters.audioStatus, "failed")))
    .returning({ bookId: chapters.bookId });
  if (!chapter) return false;
  // A Chapter is only ever 生成失败 through its job failing (failJob).
  const [failed] = await tx
    .select({ position: jobs.position })
    .from(jobs)
    .where(and(eq(jobs.chapterId, chapterId), eq(jobs.status, "failed")))
    .orderBy(desc(jobs.updatedAt))
    .limit(1);
  if (!failed) throw new Error(`chapter ${chapterId} is failed without a failed job`);
  await tx.insert(jobs).values({ bookId: chapter.bookId, type: "render_chapter", chapterId, position: failed.position });
  return true;
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
 * Ends the attempts whose lease ran out: the worker is gone, which counts as a failed attempt (PRD 4.3.5 #10).
 * A job with attempts left goes back to the queue, its Chapter to 待生成; one on its last attempt fails.
 * This happens lazily inside a claim: with no worker polling, nothing could take the job up anyway.
 */
async function endExpiredAttempts(tx: Tx, now: Date) {
  const expired = await tx.select().from(jobs).where(leaseExpired(now)).for("update", { skipLocked: true });
  for (const job of expired) {
    const error = `lease expired on attempt ${job.attempt} of ${MAX_JOB_ATTEMPTS}`;
    if (job.attempt < MAX_JOB_ATTEMPTS) await requeue(tx, job, error, now);
    else await failJob(tx, job, error, now, LEASE_EXHAUSTED_REASON);
  }
}

/**
 * Claims the next queued job, after putting back the ones whose lease expired: lowest position first (every
 * Book's parse, then every Book's first narrated Chapter, ...), oldest first within a position.
 * SKIP LOCKED keeps concurrent claims from handing one job to two workers.
 */
export async function claimNextJob(tx: Tx, now: Date, leaseMs: number): Promise<Job | undefined> {
  await endExpiredAttempts(tx, now);
  const [next] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.status, "queued"))
    .orderBy(asc(jobs.position), asc(jobs.createdAt), asc(jobs.id))
    .limit(1)
    .for("update", { skipLocked: true });
  if (!next) return undefined;
  const [claimed] = await tx
    .update(jobs)
    .set({
      status: "running",
      attempt: sql`${jobs.attempt} + 1`,
      startedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(eq(jobs.id, next.id))
    .returning();
  return claimed;
}
