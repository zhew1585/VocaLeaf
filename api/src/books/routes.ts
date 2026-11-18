import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, sql, sum } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import {
  BookDetailSchema,
  BookSchema,
  ErrorSchema,
  SentenceSchema,
  UploadBookSchema,
  type Book,
} from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, jobs, sentences } from "../db/schema.js";
import { currentUser, type UserEnv } from "../dev-identity.js";
import { sourceKey } from "../storage.js";
import { validationHook } from "../validation.js";
import { notFound, ownBook } from "./own-book.js";
import { estimateDurationMs, hasAudio, loadTimeline, loadTimelines, type Timeline } from "./timeline.js";

const uploadRoute = createRoute({
  method: "post",
  path: "/books",
  summary: "Upload an EPUB; creates a Book in parsing and queues a parse job",
  request: {
    body: { required: true, content: { "multipart/form-data": { schema: UploadBookSchema } } },
  },
  responses: {
    201: { description: "Book created", content: { "application/json": { schema: BookSchema } } },
    400: { description: "Invalid upload", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/books",
  summary: "The current user's uploaded Books, newest first",
  responses: {
    200: { description: "Books", content: { "application/json": { schema: z.array(BookSchema) } } },
  },
});

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



type BookRow = typeof books.$inferSelect;

function toBook(row: BookRow, timeline: Timeline | undefined): Book {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    status: row.status,
    playable: timeline ? hasAudio(timeline) : false,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
  };
}


/** Title before parsing: the file name without its extension (PRD 4.2.1). */
function titleFromFileName(name: string): string {
  return name.replace(/\.epub$/i, "").trim() || "Untitled";
}

/** User-facing Book routes. */
export function bookRoutes({ db, storage }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });
  for (const path of ["/books", "/books/*", "/chapters/*"]) app.use(path, currentUser);

  app.openapi(uploadRoute, async (c) => {
    const { file } = c.req.valid("form");
    // PRD 4.3.2: only .epub is accepted; nothing is stored or created otherwise.
    if (!/\.epub$/i.test(file.name)) {
      return c.json({ error: { code: "unsupported_format", message: "目前只支持 EPUB 格式" } }, 400);
    }
    const id = crypto.randomUUID();
    // Store the file first so a queued parse job never points at a missing object.
    await storage.putObject(sourceKey(id), new Uint8Array(await file.arrayBuffer()), "application/epub+zip");
    const row = await db.transaction(async (tx) => {
      const [book] = await tx
        .insert(books)
        .values({ id, ownerId: c.get("userId"), title: titleFromFileName(file.name), fileSize: file.size })
        .returning();
      await tx.insert(jobs).values({ bookId: id, type: "parse" });
      return book!;
    });
    return c.json(toBook(row, undefined), 201);
  });

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

    return c.json(
      {
        ...toBook(book, await loadTimeline(db, id)),
        chapters: rows.map(({ spokenChars: _, ...chapter }) => chapter),
        durationMs: estimateDurationMs(rows.map((r) => ({ ...r, spokenChars: r.spokenChars ?? 0 }))),
      },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const rows = await db
      .select()
      .from(books)
      .where(eq(books.ownerId, c.get("userId")))
      .orderBy(desc(books.createdAt));
    const timelines = await loadTimelines(db, rows.map((b) => b.id));
    return c.json(rows.map((b) => toBook(b, timelines.get(b.id))), 200);
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
