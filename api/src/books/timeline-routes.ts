import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { BookTimelineSchema, ErrorSchema, type AudioStatus, type BookTimeline } from "../contract.js";
import { chapters, sentences } from "../db/schema.js";
import { validationHook } from "../validation.js";
import { notFound, ownBook } from "./own-book.js";
import { entryEndMs, loadTimeline, type Timeline } from "./timeline.js";

const timelineRoute = createRoute({
  method: "get",
  path: "/books/{id}/timeline",
  summary: "Where the Book's Sentences and narrated Chapters sit in its audio (重听, 下一句, 本章结束)",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "The Book's timeline", content: { "application/json": { schema: BookTimelineSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/**
 * The Chapters in the playlist with their spans. A Chapter still generating (only ever the last one) has no end
 * yet; one generated, or failed with what it published, ends where its audio does.
 */
function chapterSpans(timeline: Timeline, statuses: ReadonlyMap<string, AudioStatus>): BookTimeline["chapters"] {
  return timeline.entries
    .filter((e) => e.segments.length > 0)
    .map((e) => {
      const status = statuses.get(e.chapterId);
      const done = status === "generated" || status === "failed";
      return { id: e.chapterId, startMs: e.offsetMs, endMs: done ? entryEndMs(e) : null };
    });
}

/** GET /books/{id}/timeline. */
export function bookTimelineRoutes({ db }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(timelineRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await ownBook(db, id, c.get("userId")))) return c.json(notFound, 404);

    const timeline = await loadTimeline(db, id);
    const offsets = new Map(timeline.entries.map((e) => [e.chapterId, e.offsetMs]));
    const statuses = new Map(
      (await db.select({ id: chapters.id, audioStatus: chapters.audioStatus }).from(chapters).where(eq(chapters.bookId, id))).map(
        (c) => [c.id, c.audioStatus] as const,
      ),
    );
    // Stored times count from their Chapter's start; Chapters outside the playlist have none that count.
    const rows = await db
      .select({ chapterId: sentences.chapterId, startMs: sentences.startMs })
      .from(sentences)
      .innerJoin(chapters, eq(chapters.id, sentences.chapterId))
      .where(and(eq(chapters.bookId, id), isNotNull(sentences.startMs)))
      .orderBy(asc(chapters.index), asc(sentences.index));
    const sentenceStartsMs = rows
      .flatMap((r) => {
        const offset = offsets.get(r.chapterId);
        return offset === undefined ? [] : [offset + r.startMs!];
      })
      .sort((a, b) => a - b);

    return c.json({ sentenceStartsMs, chapters: chapterSpans(timeline, statuses), complete: timeline.complete }, 200);
  });

  return app;
}
