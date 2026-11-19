// The Shelf page's routes (F3): the user's Books in Shelf order, listening progress, and covers.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { BookSchema, ErrorSchema, ListeningUpdateSchema } from "../contract.js";
import { coverKey } from "../storage.js";
import { validationHook } from "../validation.js";
import { notFound, readableBook } from "./own-book.js";
import { loadListening, recordListening, shelfBooks } from "./shelf.js";
import { loadTimelines } from "./timeline.js";
import { loadProgress, NO_PROGRESS, toBook } from "./view.js";

const listRoute = createRoute({
  method: "get",
  path: "/books",
  summary: "The current user's Shelf: Books last listened to first, then the others newest first (PRD 4.2.3)",
  responses: {
    200: { description: "Books", content: { "application/json": { schema: z.array(BookSchema) } } },
  },
});

const listeningRoute = createRoute({
  method: "put",
  path: "/books/{id}/listening",
  summary: "Records where the user is in the Book: the Sentence at this position of its audio",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { required: true, content: { "application/json": { schema: ListeningUpdateSchema } } },
  },
  responses: {
    204: { description: "Recorded" },
    404: { description: "Not on the user's Shelf", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const coverRoute = createRoute({
  method: "get",
  path: "/books/{id}/cover",
  summary: "The Book's cover image, taken from its EPUB",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "The image", content: { "image/*": { schema: z.string().openapi({ format: "binary" }) } } },
    404: { description: "No such Book, or it has no cover", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function shelfRoutes({ db, storage, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const rows = await shelfBooks(db, userId);
    const ids = rows.map((b) => b.id);
    const [timelines, progress] = await Promise.all([loadTimelines(db, ids), loadProgress(db, ids)]);
    const listening = await loadListening(db, userId, ids, timelines);
    return c.json(
      rows.map((b) => toBook(b, timelines.get(b.id), progress.get(b.id) ?? NO_PROGRESS, listening.get(b.id) ?? null)),
      200,
    );
  });

  app.openapi(listeningRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { positionMs } = c.req.valid("json");
    const recorded = await recordListening(db, c.get("userId"), id, positionMs, now());
    return recorded ? c.body(null, 204) : c.json(notFound, 404);
  });

  app.openapi(coverRoute, async (c) => {
    const { id } = c.req.valid("param");
    const book = await readableBook(db, id, c.get("userId"));
    const bytes = book?.coverType ? await storage.getObject(coverKey(id)) : undefined;
    if (!book?.coverType || !bytes) return c.json(notFound, 404);
    // A Book is parsed once (PRD 4.2.6), so its cover never changes.
    return c.body(new Uint8Array(bytes).buffer, 200, {
      "Content-Type": book.coverType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  return app;
}
