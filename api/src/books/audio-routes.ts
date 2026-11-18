// The Book's audio as players fetch it: one HLS playlist and its segments (PRD 4.4.1).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import { ErrorSchema } from "../contract.js";
import { audioSegments, chapters } from "../db/schema.js";
import { currentUser, type UserEnv } from "../dev-identity.js";
import { validationHook } from "../validation.js";
import { notFound, ownBook } from "./own-book.js";
import { loadTimeline, toM3u8 } from "./timeline.js";

const playlistRoute = createRoute({
  method: "get",
  path: "/books/{id}/audio.m3u8",
  summary: "The Book's audio as one HLS playlist of its narrated Chapters (PRD 4.4.1)",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "HLS media playlist", content: { "application/vnd.apple.mpegurl": { schema: z.string() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** A segment's file name in the playlist: its ID plus the extension players expect. */
const SEGMENT_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ts$/;

const segmentRoute = createRoute({
  method: "get",
  path: "/books/{id}/segments/{segment}",
  summary: "One HLS segment of the Book's audio (AAC in MPEG-TS), as listed in its playlist: `{segmentId}.ts`",
  request: { params: z.object({ id: z.uuid(), segment: z.string().regex(SEGMENT_FILE) }) },
  responses: {
    200: { description: "Segment", content: { "video/mp2t": { schema: z.string().openapi({ format: "binary" }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** Playlist and segment routes; both check that the Book belongs to the current user. */
export function audioRoutes({ db, storage }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });
  app.use("/books/*", currentUser);

  app.openapi(playlistRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await ownBook(db, id, c.get("userId")))) return c.json(notFound, 404);
    const body = toM3u8(await loadTimeline(db, id));
    // Players reload the playlist while the Book is generating, so it must never be cached.
    return c.body(body, 200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" });
  });

  app.openapi(segmentRoute, async (c) => {
    const { id, segment: file } = c.req.valid("param");
    const segmentId = file.slice(0, -".ts".length);
    if (!(await ownBook(db, id, c.get("userId")))) return c.json(notFound, 404);
    const [segment] = await db
      .select({ key: audioSegments.key })
      .from(audioSegments)
      .innerJoin(chapters, eq(chapters.id, audioSegments.chapterId))
      .where(and(eq(audioSegments.id, segmentId), eq(chapters.bookId, id)));
    const bytes = segment && (await storage.getObject(segment.key));
    if (!bytes) return c.json(notFound, 404);
    // A segment never changes once written; a re-rendered Chapter gets new segment IDs.
    return c.body(new Uint8Array(bytes).buffer, 200, { "Content-Type": "video/mp2t", "Cache-Control": "private, max-age=31536000, immutable" });
  });


  return app;
}
