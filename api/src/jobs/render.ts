// Generating one Chapter's audio (PRD 4.3.4 steps 5 to 8): what a render claim hands the worker,
// and how the worker's reports become segments, Sentence timings and Chapter status.
import { and, asc, count, eq, isNull, sum } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { ClaimedRenderJob, RenderReport } from "../contract.js";
import { audioSegments, books, chapters, sentences } from "../db/schema.js";
import { audioPrefix } from "../storage.js";
import { finishBookIfDone, succeedJob, type Job, type Tx } from "./lifecycle.js";

type RenderClaim = Omit<ClaimedRenderJob, "id" | "type" | "bookId" | "attempt" | "leaseMs">;

/**
 * Starts (or, after a lost lease, restarts) a Chapter: it becomes 生成中 and whatever an earlier claim
 * already reported is dropped, since the new claim renders the whole Chapter again under its own prefix.
 */
export async function startRender(tx: Tx, job: Job): Promise<RenderClaim> {
  const chapterId = job.chapterId!;
  await tx.update(chapters).set({ audioStatus: "generating" }).where(eq(chapters.id, chapterId));
  await tx.delete(audioSegments).where(eq(audioSegments.chapterId, chapterId));
  await tx
    .update(sentences)
    .set({ startMs: null, endMs: null, wordTimings: null })
    .where(eq(sentences.chapterId, chapterId));

  const [book] = await tx.select({ voice: books.voice }).from(books).where(eq(books.id, job.bookId));
  const rows = await tx
    .select({ id: sentences.id, spokenText: sentences.spokenText })
    .from(sentences)
    .where(eq(sentences.chapterId, chapterId))
    .orderBy(asc(sentences.index));
  return {
    chapterId,
    voice: book!.voice,
    audioPrefix: audioPrefix(job.bookId, chapterId, job.id, job.attempt),
    sentences: rows,
  };
}

function invalid(message: string): never {
  throw new HTTPException(400, { res: Response.json({ error: { code: "invalid_request", message } }, { status: 400 }) });
}

/** Stores the segments and Sentence timings of one report. Rejects anything outside the claimed Chapter. */
export async function storeRenderReport(tx: Tx, job: Job, report: Omit<RenderReport, "attempt">) {
  const chapterId = job.chapterId!;
  const prefix = audioPrefix(job.bookId, chapterId, job.id, job.attempt);
  if (report.segments.some((s) => !s.key.startsWith(prefix))) invalid(`segment keys must start with ${prefix}`);

  if (report.segments.length > 0) {
    await tx
      .insert(audioSegments)
      .values(report.segments.map((s) => ({ chapterId, ...s })))
      .onConflictDoNothing();
  }
  for (const s of report.sentences) {
    const updated = await tx
      .update(sentences)
      .set({ startMs: s.startMs, endMs: s.endMs, wordTimings: s.wordTimings })
      .where(and(eq(sentences.id, s.id), eq(sentences.chapterId, chapterId)))
      .returning({ id: sentences.id });
    if (updated.length === 0) invalid(`sentence ${s.id} is not in chapter ${chapterId}`);
  }
}

/**
 * Finishes a Chapter after its last report: 已生成 with its duration, and the Book 已就绪 if it was the last
 * one. Refused while any of its Sentences has no timing, so a generated Chapter is always fully timed.
 */
export async function finishRender(tx: Tx, job: Job, now: Date) {
  const chapterId = job.chapterId!;
  const [untimed] = await tx
    .select({ n: count() })
    .from(sentences)
    .where(and(eq(sentences.chapterId, chapterId), isNull(sentences.startMs)));
  if (untimed!.n > 0) invalid(`${untimed!.n} sentences of chapter ${chapterId} have no timing`);

  const [total] = await tx
    .select({ ms: sum(audioSegments.durationMs).mapWith(Number) })
    .from(audioSegments)
    .where(eq(audioSegments.chapterId, chapterId));
  await tx
    .update(chapters)
    .set({ audioStatus: "generated", durationMs: total!.ms ?? 0 })
    .where(eq(chapters.id, chapterId));
  await succeedJob(tx, job, now);
  await finishBookIfDone(tx, job.bookId);
}
