// The 书库 (F6, PRD 4.2.2): Library Books grouped by difficulty, and putting one on the Shelf or taking it off.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, exists, sql } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { ErrorSchema, LibraryBookSchema } from "../contract.js";
import { books, shelfEntries } from "../db/schema.js";
import { validationHook } from "../validation.js";
import { notFound, readableBook } from "./own-book.js";
import { addToShelf, removeFromShelf } from "./shelf.js";
import { coverUrl } from "./view.js";

const listRoute = createRoute({
  method: "get",
  path: "/library",
  summary: "Library Books ready to play, by difficulty (入门, 中级, 进阶) and then title (PRD 4.2.2)",
  responses: {
    200: { description: "Library Books", content: { "application/json": { schema: z.array(LibraryBookSchema) } } },
  },
});

const addRoute = createRoute({
  method: "put",
  path: "/books/{id}/shelf",
  summary: "Puts a Library Book on the user's Shelf (【加入书架并播放】); one already there keeps its progress",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "On the Shelf" },
    404: { description: "No such Book", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const removeRoute = createRoute({
  method: "delete",
  path: "/books/{id}/shelf",
  summary:
    "Takes a Library Book off the user's Shelf (【移出书架】, PRD 4.2.3): drops their progress, keeps the shared Book",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Off the Shelf" },
    404: { description: "No such Book", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "An uploaded Book, which is deleted instead", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const uploadedBook = {
  error: { code: "uploaded_book", message: "上传的书不能移出书架，只能删除" },
} as const;

export function libraryRoutes({ db, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const onShelf = exists(
      db
        .select({ one: sql`1` })
        .from(shelfEntries)
        .where(and(eq(shelfEntries.bookId, books.id), eq(shelfEntries.userId, userId))),
    );
    // Only fully generated Books, so 【加入书架并播放】 always plays at once (AC-LIB-01).
    const rows = await db
      .select({
        id: books.id,
        title: books.title,
        author: books.author,
        difficulty: books.difficulty,
        blurb: books.blurb,
        coverType: books.coverType,
        onShelf: sql<boolean>`${onShelf}`.mapWith(Boolean),
      })
      .from(books)
      .where(and(eq(books.source, "library"), eq(books.status, "ready")))
      // The enum's order is the display order of the groups.
      .orderBy(asc(books.difficulty), sql`lower(${books.title})`, asc(books.id));
    return c.json(
      rows.map(({ coverType, difficulty, blurb, ...row }) => ({
        ...row,
        // A Library Book always has both (the books_owner_matches_source check and the catalog).
        difficulty: difficulty!,
        blurb: blurb ?? "",
        coverUrl: coverUrl({ id: row.id, coverType }),
      })),
      200,
    );
  });

  app.openapi(addRoute, async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    const book = await readableBook(db, id, userId);
    if (!book) return c.json(notFound, 404);
    // An uploaded Book is on its uploader's Shelf from the start.
    if (book.source === "library") await addToShelf(db, userId, id, now());
    return c.body(null, 204);
  });

  app.openapi(removeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    const book = await readableBook(db, id, userId);
    if (!book) return c.json(notFound, 404);
    if (book.source !== "library") return c.json(uploadedBook, 409);
    await removeFromShelf(db, userId, id);
    return c.body(null, 204);
  });

  return app;
}
