// Changing a Book's Voice (PRD 4.2.4, 4.3.4 更换音色): the whole Book's audio is generated again in the new
// Voice next to the audio that plays meanwhile, then switched over in one transaction.
//
// - Starting queues one render_voice_change job per generated narrated Chapter. Their segments are stored with
//   the new Voice, which the playlist leaves out (it plays only the Book's Voice), and their Sentence timings
//   wait in stagedSentenceTimings. Sentence IDs never change (PRD 4.2.6), so progress, Marks and Cards stay put.
// - Once every job succeeded, completeVoiceChangeIfDone switches: the staged timings replace the Sentences'
//   timings, Chapters get their new durations, and the Book's Voice becomes the new one. A player holding the old
//   playlist sees the Voice change and loads the new one at the same Sentence (web/src/pages/usePlaylist.ts);
//   until it has, the positions it reports are in the old Voice and are not placed (books/shelf.ts).
// - When a job fails for good, failVoiceChange drops the change: the old audio plays on (PRD 4.3.5 #11).
// - Segments in a Voice other than the Book's (the Voice changed from, or a failed change) stay servable for a
//   player still holding them, and are deleted, objects too, when the next change starts.
//
// Cards (#15) keep their own copy of a Sentence's audio and text when they are made (CONTEXT.md, PRD 4.5.2), so
// neither the switch nor deleting the old Voice's segments changes them: copy the bytes, never point at segments.
import { and, asc, eq, exists, inArray, ne, notInArray, sql, sum } from "drizzle-orm";
import type { Voice } from "../contract.js";
import { audioSegments, books, chapters, jobs, sentences, stagedSentenceTimings } from "../db/schema.js";
import type { Job, Tx } from "./lifecycle.js";

export type VoiceChangeRefusal = "not_changeable" | "not_ready" | "running" | "same_voice";

type BookRow = typeof books.$inferSelect;

/** Whether a Voice change of the Book is under way (one that failed is over). */
export function isVoiceChanging(book: Pick<BookRow, "voiceChangeTo" | "voiceChangeFailed">): boolean {
  return book.voiceChangeTo !== null && !book.voiceChangeFailed;
}

export type VoiceChangeOutcome =
  | { started: true; /** Objects of segments no player can reach any more; delete them after the commit. */ staleKeys: string[] }
  | { started: false; refusal: VoiceChangeRefusal };

/** IDs of the Book's Chapters, as a subquery. */
function chapterIdsOf(tx: Tx, bookId: string) {
  return tx.select({ id: chapters.id }).from(chapters).where(eq(chapters.bookId, bookId));
}

/** Drops the staged timings of the Book's Sentences. */
async function dropStaged(tx: Tx, bookId: string) {
  const ids = tx.select({ id: sentences.id }).from(sentences).where(inArray(sentences.chapterId, chapterIdsOf(tx, bookId)));
  await tx.delete(stagedSentenceTimings).where(inArray(stagedSentenceTimings.sentenceId, ids));
}

/** Whether a narrated Chapter of the Book is still to generate, such as a retried one in a 已就绪 Book. */
async function hasChaptersToGenerate(tx: Tx, bookId: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: chapters.id })
    .from(chapters)
    .where(
      and(eq(chapters.bookId, bookId), eq(chapters.skipped, false), inArray(chapters.audioStatus, ["pending", "generating"])),
    )
    .limit(1);
  return open !== undefined;
}

/**
 * Starts changing the Book to `voice`. Refused for a Library Book (PRD 4.2.2), while another change runs (PRD
 * 4.2.4 rule 6), until the Book's audio is all there to replace (已就绪, no retried Chapter still generating in
 * the old Voice), and to the Voice it has. The caller locks the Book's row, which retrying a Chapter locks too,
 * so neither a second change nor a retry slips in.
 */
export async function startVoiceChange(tx: Tx, book: BookRow, voice: Voice): Promise<VoiceChangeOutcome> {
  if (book.source !== "upload") return { started: false, refusal: "not_changeable" };
  if (isVoiceChanging(book)) return { started: false, refusal: "running" };
  if (book.status !== "ready" || (await hasChaptersToGenerate(tx, book.id))) return { started: false, refusal: "not_ready" };
  if (voice === book.voice) return { started: false, refusal: "same_voice" };

  const stale = await tx
    .delete(audioSegments)
    .where(and(inArray(audioSegments.chapterId, chapterIdsOf(tx, book.id)), ne(audioSegments.voice, book.voice)))
    .returning({ key: audioSegments.key });
  await dropStaged(tx, book.id);

  // Failed Chapters have no audio to replace; retried after the change, they generate in the new Voice.
  const toRender = await tx
    .select({ id: chapters.id })
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, book.id),
        eq(chapters.skipped, false),
        eq(chapters.audioStatus, "generated"),
        exists(tx.select({ id: sentences.id }).from(sentences).where(eq(sentences.chapterId, chapters.id))),
      ),
    )
    .orderBy(asc(chapters.index));
  if (toRender.length > 0) {
    await tx.insert(jobs).values(
      toRender.map((ch, i) => ({
        bookId: book.id,
        type: "render_voice_change" as const,
        chapterId: ch.id,
        voice,
        // Like a new Book's Chapters, so a change does not hold up other Books' first Chapters.
        position: i + 1,
      })),
    );
  }
  await tx.update(books).set({ voiceChangeTo: voice, voiceChangeFailed: false }).where(eq(books.id, book.id));
  await completeVoiceChangeIfDone(tx, book.id);
  return { started: true, staleKeys: stale.map((s) => s.key) };
}

/** Whether a Voice change of the Book still has a job to finish. */
async function hasOpenJobs(tx: Tx, bookId: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.bookId, bookId), eq(jobs.type, "render_voice_change"), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return open !== undefined;
}

/**
 * Switches the Book to the Voice it is changing to once every Chapter of the change is generated (PRD 4.2.4
 * rule 3), all in the caller's transaction: Sentences take their staged timings, Chapters their new durations,
 * and the Book its new Voice, which is what the playlist plays from then on.
 * A Chapter without audio in the new Voice loses its old timings: a Skipped one that kept audio from before goes
 * back to 待生成 (generated again once narrated), a failed one stays failed.
 */
export async function completeVoiceChangeIfDone(tx: Tx, bookId: string) {
  const [book] = await tx.select().from(books).where(eq(books.id, bookId)).for("update");
  const to = book?.voiceChangeTo;
  if (!to || book.voiceChangeFailed || (await hasOpenJobs(tx, bookId))) return;

  await tx
    .update(sentences)
    .set({
      startMs: sql`${stagedSentenceTimings.startMs}`,
      endMs: sql`${stagedSentenceTimings.endMs}`,
      wordTimings: sql`${stagedSentenceTimings.wordTimings}`,
    })
    .from(stagedSentenceTimings)
    .where(
      and(
        eq(stagedSentenceTimings.sentenceId, sentences.id),
        eq(stagedSentenceTimings.voice, to),
        inArray(sentences.chapterId, chapterIdsOf(tx, bookId)),
      ),
    );

  const durations = await tx
    .select({ chapterId: audioSegments.chapterId, ms: sum(audioSegments.durationMs).mapWith(Number) })
    .from(audioSegments)
    .where(and(inArray(audioSegments.chapterId, chapterIdsOf(tx, bookId)), eq(audioSegments.voice, to)))
    .groupBy(audioSegments.chapterId);
  for (const d of durations) await tx.update(chapters).set({ durationMs: d.ms }).where(eq(chapters.id, d.chapterId));

  const voiced = durations.map((d) => d.chapterId);
  const unvoiced = and(eq(chapters.bookId, bookId), voiced.length > 0 ? notInArray(chapters.id, voiced) : undefined);
  await tx
    .update(sentences)
    .set({ startMs: null, endMs: null, wordTimings: null })
    .where(inArray(sentences.chapterId, tx.select({ id: chapters.id }).from(chapters).where(unvoiced)));
  await tx
    .update(chapters)
    .set({ audioStatus: "pending", durationMs: null })
    .where(and(unvoiced, eq(chapters.skipped, true), eq(chapters.audioStatus, "generated")));

  await dropStaged(tx, bookId);
  await tx.update(books).set({ voice: to, voiceChangeTo: null }).where(eq(books.id, bookId));
}

/**
 * A Chapter of a Voice change failed for good: the change is dropped and the Book keeps its Voice and audio
 * (PRD 4.2.4 rule 4, 4.3.5 #11). The change's other jobs are cancelled by deleting them: a worker still holding
 * one hears 409 at its next report, and the objects it reports are deleted (books/delete.ts
 * discardDeletedJobSegments). Segments already stored in the new Voice never play and go with the next change.
 */
export async function failVoiceChange(tx: Tx, job: Job, error: string, now: Date) {
  await tx.update(jobs).set({ status: "failed", error, leaseExpiresAt: null, updatedAt: now }).where(eq(jobs.id, job.id));
  await tx
    .delete(jobs)
    .where(
      and(eq(jobs.bookId, job.bookId), eq(jobs.type, "render_voice_change"), inArray(jobs.status, ["queued", "running"])),
    );
  await dropStaged(tx, job.bookId);
  await tx.update(books).set({ voiceChangeFailed: true }).where(eq(books.id, job.bookId));
}
