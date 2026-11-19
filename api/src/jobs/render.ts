// Generating one Chapter's audio (PRD 4.3.4 steps 5 to 8): what a render claim hands the worker,
// and how the worker's reports become segments, Sentence timings and Chapter status.
// A render_voice_change job renders the same way, but into the Voice the Book is changing to: its segments and
// timings wait aside, the Chapter's status and playing audio stay as they are (jobs/voice-change.ts).
import { and, asc, count, eq, inArray, isNull, sql, sum } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { ClaimedRenderJob, RenderReport, Voice } from "../contract.js";
import { audioSegments, books, chapters, jobs, sentences, stagedSentenceTimings } from "../db/schema.js";
import { audioPrefix } from "../storage.js";
import { finishBookIfDone, succeedJob, type Job, type Tx } from "./lifecycle.js";
import { completeVoiceChangeIfDone } from "./voice-change.js";

type RenderClaim = Omit<ClaimedRenderJob, "id" | "type" | "bookId" | "attempt" | "leaseMs">;

const isVoiceChange = (job: Job) => job.type === "render_voice_change";

/** A render_chapter claim renders the Book's Voice: its Chapter becomes 生成中, the job records the Voice. */
async function claimInBookVoice(tx: Tx, job: Job): Promise<Voice> {
  await tx.update(chapters).set({ audioStatus: "generating" }).where(eq(chapters.id, job.chapterId!));
  const [book] = await tx.select({ voice: books.voice }).from(books).where(eq(books.id, job.bookId));
  await tx.update(jobs).set({ voice: book!.voice }).where(eq(jobs.id, job.id));
  return book!.voice;
}

/**
 * Starts a Chapter: it becomes 生成中 (unless this is a Voice change, which leaves the playing audio alone).
 * After a lost lease the new claim renders the whole Chapter again, but segments the earlier claim already
 * published stay: a player may hold them, and the playlist only ever grows. The new claim's reports for those
 * indices are ignored (see storeRenderReport); Kokoro is not bit-exact between runs, so the seam can be off by a
 * few milliseconds.
 */
export async function startRender(tx: Tx, job: Job): Promise<RenderClaim> {
  const chapterId = job.chapterId!;
  const voice = isVoiceChange(job) ? job.voice! : await claimInBookVoice(tx, job);
  const rows = await tx
    .select({ id: sentences.id, spokenText: sentences.spokenText, paragraphIndex: sentences.paragraphIndex })
    .from(sentences)
    .where(eq(sentences.chapterId, chapterId))
    .orderBy(asc(sentences.index));
  return {
    chapterId,
    voice,
    audioPrefix: audioPrefix(job.bookId, chapterId, job.id, job.attempt),
    sentences: rows,
  };
}

function invalid(message: string): never {
  throw new HTTPException(400, { res: Response.json({ error: { code: "invalid_request", message } }, { status: 400 }) });
}

/** Keeps a Voice change's Sentence timings aside (stagedSentenceTimings), refusing Sentences outside the Chapter. */
async function stageTimings(tx: Tx, job: Job, timed: RenderReport["sentences"]) {
  if (timed.length === 0) return;
  const ids = timed.map((s) => s.id);
  const inChapter = new Set(
    (
      await tx
        .select({ id: sentences.id })
        .from(sentences)
        .where(and(eq(sentences.chapterId, job.chapterId!), inArray(sentences.id, ids)))
    ).map((r) => r.id),
  );
  const outside = ids.find((id) => !inChapter.has(id));
  if (outside) invalid(`sentence ${outside} is not in chapter ${job.chapterId}`);
  await tx
    .insert(stagedSentenceTimings)
    .values(timed.map((s) => ({ sentenceId: s.id, voice: job.voice!, startMs: s.startMs, endMs: s.endMs, wordTimings: s.wordTimings })))
    .onConflictDoUpdate({
      target: stagedSentenceTimings.sentenceId,
      set: {
        voice: sql`excluded.voice`,
        startMs: sql`excluded.start_ms`,
        endMs: sql`excluded.end_ms`,
        wordTimings: sql`excluded.word_timings`,
      },
    });
}

/**
 * Stores the segments and Sentence timings of one report. Rejects anything outside the claimed Chapter.
 * A segment index already published (by an earlier claim of this Chapter in this Voice) keeps its first segment.
 */
export async function storeRenderReport(tx: Tx, job: Job, report: Omit<RenderReport, "attempt">) {
  const chapterId = job.chapterId!;
  const prefix = audioPrefix(job.bookId, chapterId, job.id, job.attempt);
  if (report.segments.some((s) => !s.key.startsWith(prefix))) invalid(`segment keys must start with ${prefix}`);

  if (report.segments.length > 0) {
    await tx
      .insert(audioSegments)
      .values(report.segments.map((s) => ({ chapterId, voice: job.voice!, ...s })))
      .onConflictDoNothing();
  }
  if (isVoiceChange(job)) return stageTimings(tx, job, report.sentences);
  for (const s of report.sentences) {
    const updated = await tx
      .update(sentences)
      .set({ startMs: s.startMs, endMs: s.endMs, wordTimings: s.wordTimings })
      .where(and(eq(sentences.id, s.id), eq(sentences.chapterId, chapterId)))
      .returning({ id: sentences.id });
    if (updated.length === 0) invalid(`sentence ${s.id} is not in chapter ${chapterId}`);
  }
}

/** Sentences of the Chapter without a timing in the job's Voice. */
async function untimedSentences(tx: Tx, job: Job): Promise<number> {
  const chapterId = job.chapterId!;
  const [row] = isVoiceChange(job)
    ? await tx
        .select({ n: count() })
        .from(sentences)
        .leftJoin(stagedSentenceTimings, eq(stagedSentenceTimings.sentenceId, sentences.id))
        .where(and(eq(sentences.chapterId, chapterId), isNull(stagedSentenceTimings.sentenceId)))
    : await tx
        .select({ n: count() })
        .from(sentences)
        .where(and(eq(sentences.chapterId, chapterId), isNull(sentences.startMs)));
  return row!.n;
}

/**
 * Finishes a Chapter after its last report: 已生成 with its duration, and the Book 已就绪 if it was the last
 * one; for a Voice change, the change completes if it was the last Chapter. Refused while any of its Sentences
 * has no timing, so a generated Chapter is always fully timed.
 */
export async function finishRender(tx: Tx, job: Job, now: Date) {
  const chapterId = job.chapterId!;
  const untimed = await untimedSentences(tx, job);
  if (untimed > 0) invalid(`${untimed} sentences of chapter ${chapterId} have no timing`);

  if (isVoiceChange(job)) {
    await succeedJob(tx, job, now);
    await completeVoiceChangeIfDone(tx, job.bookId);
    return;
  }
  const [total] = await tx
    .select({ ms: sum(audioSegments.durationMs).mapWith(Number) })
    .from(audioSegments)
    .where(and(eq(audioSegments.chapterId, chapterId), eq(audioSegments.voice, job.voice!)));
  await tx
    .update(chapters)
    .set({ audioStatus: "generated", durationMs: total!.ms ?? 0 })
    .where(eq(chapters.id, chapterId));
  await succeedJob(tx, job, now);
  await finishBookIfDone(tx, job.bookId);
}
