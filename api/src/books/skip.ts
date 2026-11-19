// Setting a Chapter Skipped or narrated (PRD 4.2.5 用户调整, F5): the user's route and what it does to the
// generation queue. The playlist follows by itself: it is built from the Chapters' flags (books/timeline.ts).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq, inArray, lte } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { ChapterSkippedUpdateSchema, ErrorSchema } from "../contract.js";
import { books, chapters, jobs, sentences } from "../db/schema.js";
import { finishBookIfDone, type Tx } from "../jobs/lifecycle.js";
import { validationHook } from "../validation.js";
import { notFound } from "./own-book.js";

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
  },
});

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
 * Narrates a Skipped Chapter. Generated audio comes back into the playlist at once. Otherwise the Chapter is
 * generated out of Chapter order (narratedByUser), queued among the Book's other narrated Chapters in Chapter order,
 * and comes into the playlist once generated (AC-BOOK-01). A Book's status does not change: 已就绪 is final
 * (PRD 4.3.3), and a generating one now also waits for this Chapter.
 */
async function narrateChapter(tx: Tx, chapter: ChapterRow) {
  const late = chapter.audioStatus === "pending" || chapter.audioStatus === "generating";
  await tx
    .update(chapters)
    .set({ skipped: false, ...(late ? { narratedByUser: true } : {}) })
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
  // Its place among the narrated Chapters, as the jobs queued at parse time (jobs/parse.ts).
  const [rank] = await tx
    .select({ n: count() })
    .from(chapters)
    .where(and(eq(chapters.bookId, chapter.bookId), eq(chapters.skipped, false), lte(chapters.index, chapter.index)));
  await tx.insert(jobs).values({ bookId: chapter.bookId, type: "render_chapter", chapterId: chapter.id, position: rank!.n });
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
        })
        .from(chapters)
        .innerJoin(books, eq(books.id, chapters.bookId))
        .where(and(eq(chapters.id, id), eq(books.ownerId, c.get("userId"))))
        .for("update", { of: chapters });
      if (!row) return "not_found";
      if (row.source !== "upload") return "library_book";
      if (row.skipped !== skipped) await (skipped ? skipChapter(tx, row) : narrateChapter(tx, row));
      return "set";
    });
    if (outcome === "not_found") return c.json(notFound, 404);
    if (outcome === "library_book") return c.json(libraryBook, 403);
    return c.body(null, 204);
  });

  return app;
}
