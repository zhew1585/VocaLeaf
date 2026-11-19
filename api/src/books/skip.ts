// Setting a Chapter Skipped or narrated (PRD 4.2.5 用户调整, F5): the user's route and what it does to the
// generation queue. The playlist follows by itself: it is built from the Chapters' flags (books/timeline.ts).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq, gt, gte, inArray, lt, max, sql } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { ChapterSkippedUpdateSchema, ErrorSchema } from "../contract.js";
import { audioSegments, books, chapters, jobs, sentences } from "../db/schema.js";
import { finishBookIfDone, type Tx } from "../jobs/lifecycle.js";
import { isVoiceChanging } from "../jobs/voice-change.js";
import { validationHook } from "../validation.js";
import { notFound, readableBy } from "./readable-book.js";

const skippedRoute = createRoute({
  method: "put",
  path: "/chapters/{id}/skipped",
  summary: "Set a Chapter Skipped or narrated (PRD 4.2.5): narrating one without audio queues its generation",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { required: true, content: { "application/json": { schema: ChapterSkippedUpdateSchema } } },
  },
  responses: {
    204: { description: "Set; setting it to what it already is changes nothing" },
    403: { description: "A Library Book's Chapter", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "The Book's Voice is changing", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const voiceChanging = { error: { code: "voice_change_running", message: "正在更换音色，完成后再调整" } } as const;

const libraryBook = {
  error: { code: "library_book", message: "书库的书不能调整朗读章节" },
} as const;

type ChapterRow = Pick<typeof chapters.$inferSelect, "id" | "bookId" | "index" | "audioStatus">;

/**
 * Sets a narrated Chapter Skipped: it leaves the playlist at once. Its audio stays, so narrating it again needs no
 * generating; a job still queued for it is dropped (PRD 4.3.3: Skipped Chapters are not in the queue), one already
 * running finishes. The Book may be 已就绪 now that it no longer waits for this Chapter.
 */
async function skipChapter(tx: Tx, chapter: ChapterRow) {
  await tx.update(chapters).set({ skipped: true }).where(eq(chapters.id, chapter.id));
  await tx.delete(jobs).where(and(eq(jobs.chapterId, chapter.id), eq(jobs.status, "queued")));
  await finishBookIfDone(tx, chapter.bookId);
}

/**
 * Whether generation already went past the Chapter: a later narrated Chapter has audio. The Chapter is then
 * generated out of Chapter order, behind where playback may already be, and must not hold the playlist back.
 */
async function generationPassed(tx: Tx, chapter: ChapterRow): Promise<boolean> {
  const [later] = await tx
    .select({ id: audioSegments.id })
    .from(audioSegments)
    .innerJoin(chapters, eq(chapters.id, audioSegments.chapterId))
    .where(and(eq(chapters.bookId, chapter.bookId), eq(chapters.skipped, false), gt(chapters.index, chapter.index)))
    .limit(1);
  return later !== undefined;
}

/**
 * Queues the Chapter's generation right after the Chapters before it, moving the Book's queued Chapters after it
 * one place back, so the Book's Chapters are still claimed in Chapter order (claimNextJob).
 */
async function queueInChapterOrder(tx: Tx, chapter: ChapterRow) {
  const [before] = await tx
    .select({ position: max(jobs.position) })
    .from(jobs)
    .innerJoin(chapters, eq(chapters.id, jobs.chapterId))
    .where(and(eq(jobs.bookId, chapter.bookId), lt(chapters.index, chapter.index)));
  const position = (before?.position ?? 0) + 1;
  await tx
    .update(jobs)
    .set({ position: sql`${jobs.position} + 1` })
    .where(and(eq(jobs.bookId, chapter.bookId), eq(jobs.status, "queued"), gte(jobs.position, position)));
  await tx.insert(jobs).values({ bookId: chapter.bookId, type: "render_chapter", chapterId: chapter.id, position });
}

/**
 * Narrates a Skipped Chapter. Generated audio comes back into the playlist at once. Otherwise the Chapter is
 * queued in Chapter order and comes into the playlist once generated (AC-BOOK-01): in its turn, holding playback
 * like any Chapter still to generate, or, when generation already went past it, out of order (narratedByUser)
 * and whole. A Book's status does not change: 已就绪 is final (PRD 4.3.3), and a generating one now also waits
 * for this Chapter.
 */
async function narrateChapter(tx: Tx, chapter: ChapterRow) {
  const toGenerate = chapter.audioStatus === "pending" || chapter.audioStatus === "generating";
  const outOfOrder = toGenerate && (await generationPassed(tx, chapter));
  await tx
    .update(chapters)
    .set({ skipped: false, ...(outOfOrder ? { narratedByUser: true } : {}) })
    .where(eq(chapters.id, chapter.id));
  if (chapter.audioStatus !== "pending") return;

  const [open] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.chapterId, chapter.id), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  if (open) return;
  const [text] = await tx.select({ n: count() }).from(sentences).where(eq(sentences.chapterId, chapter.id));
  if (text!.n === 0) {
    // Nothing to say, as a narrated Chapter without Sentences at parse time (jobs/parse.ts).
    await tx.update(chapters).set({ audioStatus: "generated", durationMs: 0 }).where(eq(chapters.id, chapter.id));
    await finishBookIfDone(tx, chapter.bookId);
    return;
  }
  await queueInChapterOrder(tx, chapter);
}

/** PUT /chapters/{id}/skipped. */
export function skipRoutes({ db }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(skippedRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { skipped } = c.req.valid("json");
    const outcome = await db.transaction(async (tx) => {
      // Locked, so two changes of the same Chapter (a double click) queue it at most once.
      const [row] = await tx
        .select({
          id: chapters.id,
          bookId: chapters.bookId,
          index: chapters.index,
          audioStatus: chapters.audioStatus,
          skipped: chapters.skipped,
          source: books.source,
          voiceChangeTo: books.voiceChangeTo,
          voiceChangeFailed: books.voiceChangeFailed,
        })
        .from(chapters)
        .innerJoin(books, eq(books.id, chapters.bookId))
        .where(and(eq(chapters.id, id), readableBy(c.get("userId"))))
        .for("update", { of: chapters });
      if (!row) return "not_found";
      if (row.source !== "upload") return "library_book";
      // A Chapter narrated now would be generated in the old Voice and miss the change (#19).
      if (isVoiceChanging(row)) return "voice_changing";
      if (row.skipped !== skipped) await (skipped ? skipChapter(tx, row) : narrateChapter(tx, row));
      return "set";
    });
    if (outcome === "not_found") return c.json(notFound, 404);
    if (outcome === "library_book") return c.json(libraryBook, 403);
    if (outcome === "voice_changing") return c.json(voiceChanging, 409);
    return c.body(null, 204);
  });

  return app;
}
