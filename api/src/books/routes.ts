import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, eq, sql, sum } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { BookDetailSchema, ErrorSchema, SentenceSchema } from "../contract.js";
import { books, chapters, sentences } from "../db/schema.js";
import { retryFailedChapter } from "../jobs/lifecycle.js";
import { isVoiceChanging } from "../jobs/voice-change.js";
import { validationHook } from "../validation.js";
import { notFound, ownBook } from "./own-book.js";
import { loadListening } from "./shelf.js";
import { chapterStartMs, estimateDurationMs, loadTimeline } from "./timeline.js";
import { progressOf, toBook, voiceOf } from "./view.js";
import { loadChapterWaits } from "./wait.js";

const sentencesRoute = createRoute({
  method: "get",
  path: "/chapters/{id}/sentences",
  summary: "A Chapter's Sentences in order",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Sentences", content: { "application/json": { schema: z.array(SentenceSchema) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const retryRoute = createRoute({
  method: "post",
  path: "/chapters/{id}/retry",
  summary: "Generate a 生成失败 Chapter again (PRD 4.3.5 #9); it goes back to 待生成",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Chapter queued again" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "The Chapter is not 生成失败, or the Book's Voice is changing",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/books/{id}",
  summary: "A Book with its Chapters and their Sentence counts",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Book detail", content: { "application/json": { schema: BookDetailSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});



const chapterNotFailed = { error: { code: "chapter_not_failed", message: "该章节没有生成失败，无需重试" } } as const;
// A retried Chapter would generate in the old Voice while the change replaces the others (jobs/voice-change.ts).
const voiceChanging = { error: { code: "voice_change_running", message: "正在更换音色，完成后再重试" } } as const;

/** User-facing routes of one Book: its detail, its Chapters' Sentences, retrying a Chapter. */
export function bookRoutes({ db }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const book = await ownBook(db, id, c.get("userId"));
    if (!book) return c.json(notFound, 404);

    const rows = await db
      .select({
        id: chapters.id,
        index: chapters.index,
        title: chapters.title,
        skipped: chapters.skipped,
        audioStatus: chapters.audioStatus,
        sentenceCount: count(sentences.id),
        durationMs: chapters.durationMs,
        spokenChars: sum(sql<number>`length(${sentences.spokenText})`).mapWith(Number),
      })
      .from(chapters)
      .leftJoin(sentences, eq(sentences.chapterId, chapters.id))
      .where(eq(chapters.bookId, id))
      .groupBy(chapters.id)
      .orderBy(asc(chapters.index));

    const timeline = await loadTimeline(db, id);
    const listening = (await loadListening(db, c.get("userId"), [id], new Map([[id, timeline]]))).get(id) ?? null;
    const waiting = rows.some((r) => !r.skipped && (r.audioStatus === "pending" || r.audioStatus === "generating"));
    const waits = waiting ? await loadChapterWaits(db) : new Map<string, number>();
    const chapterSummaries = rows.map(({ spokenChars: _, ...chapter }) => {
      const startMs = chapterStartMs(timeline, chapter.id);
      return { ...chapter, startMs, waitSeconds: startMs === null ? (waits.get(chapter.id) ?? null) : null };
    });
    return c.json(
      {
        ...toBook(book, timeline, progressOf(rows), listening),
        ...voiceOf(book),
        chapters: chapterSummaries,
        durationMs: estimateDurationMs(rows.map((r) => ({ ...r, spokenChars: r.spokenChars ?? 0 }))),
      },
      200,
    );
  });

  app.openapi(retryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const outcome = await db.transaction(async (tx) => {
      const [chapter] = await tx
        .select({ id: chapters.id, voiceChangeTo: books.voiceChangeTo, voiceChangeFailed: books.voiceChangeFailed })
        .from(chapters)
        .innerJoin(books, eq(books.id, chapters.bookId))
        .where(and(eq(chapters.id, id), eq(books.ownerId, c.get("userId"))))
        .for("update", { of: books });
      if (!chapter) return "not_found";
      if (isVoiceChanging(chapter)) return "voice_changing";
      return (await retryFailedChapter(tx, id)) ? "retried" : "not_failed";
    });
    if (outcome === "not_found") return c.json(notFound, 404);
    if (outcome === "not_failed") return c.json(chapterNotFailed, 409);
    if (outcome === "voice_changing") return c.json(voiceChanging, 409);
    return c.body(null, 204);
  });

  app.openapi(sentencesRoute, async (c) => {
    const { id } = c.req.valid("param");
    const [chapter] = await db
      .select({ id: chapters.id, bookId: chapters.bookId })
      .from(chapters)
      .innerJoin(books, eq(books.id, chapters.bookId))
      .where(and(eq(chapters.id, id), eq(books.ownerId, c.get("userId"))));
    if (!chapter) return c.json(notFound, 404);

    const rows = await db
      .select({
        id: sentences.id,
        index: sentences.index,
        paragraphIndex: sentences.paragraphIndex,
        text: sentences.text,
        spokenText: sentences.spokenText,
        startMs: sentences.startMs,
        endMs: sentences.endMs,
        wordTimings: sentences.wordTimings,
      })
      .from(sentences)
      .where(eq(sentences.chapterId, id))
      .orderBy(asc(sentences.index));
    // Stored times count from the Chapter's start; the Book's audio places the Chapter after the ones before it.
    const entry = (await loadTimeline(db, chapter.bookId)).entries.find((e) => e.chapterId === id);
    const offset = (ms: number | null) => (entry && ms !== null ? entry.offsetMs + ms : null);
    return c.json(
      rows.map((s) => ({ ...s, startMs: offset(s.startMs), endMs: offset(s.endMs), wordTimings: entry ? s.wordTimings : null })),
      200,
    );
  });

  return app;
}
