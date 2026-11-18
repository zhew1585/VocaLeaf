import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import {
  BookDetailSchema,
  BookSchema,
  ErrorSchema,
  SentenceSchema,
  UploadBookSchema,
  type Book,
} from "../contract.js";
import { books, chapters, jobs, sentences } from "../db/schema.js";
import { currentUser, type UserEnv } from "../dev-identity.js";
import { sourceKey } from "../storage.js";
import { validationHook } from "../validation.js";

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

const notFound = { error: { code: "not_found", message: "书不存在" } } as const;

type BookRow = typeof books.$inferSelect;

function toBook(row: BookRow): Book {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    status: row.status,
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
    return c.json(toBook(row), 201);
  });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.id, id), eq(books.ownerId, c.get("userId"))));
    if (!book) return c.json(notFound, 404);

    const rows = await db
      .select({
        id: chapters.id,
        index: chapters.index,
        title: chapters.title,
        skipped: chapters.skipped,
        audioStatus: chapters.audioStatus,
        sentenceCount: count(sentences.id),
      })
      .from(chapters)
      .leftJoin(sentences, eq(sentences.chapterId, chapters.id))
      .where(eq(chapters.bookId, id))
      .groupBy(chapters.id)
      .orderBy(asc(chapters.index));

    return c.json({ ...toBook(book), chapters: rows }, 200);
  });

  app.openapi(listRoute, async (c) => {
    const rows = await db
      .select()
      .from(books)
      .where(eq(books.ownerId, c.get("userId")))
      .orderBy(desc(books.createdAt));
    return c.json(rows.map(toBook), 200);
  });

  app.openapi(sentencesRoute, async (c) => {
    const { id } = c.req.valid("param");
    const [chapter] = await db
      .select({ id: chapters.id })
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
      })
      .from(sentences)
      .where(eq(sentences.chapterId, id))
      .orderBy(asc(sentences.index));
    return c.json(rows, 200);
  });

  return app;
}
