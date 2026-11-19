// Deleting an uploaded Book (PRD 4.3.6): the user's route, and the cleanup of audio a worker still writes for it.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { ErrorSchema } from "../contract.js";
import type { Db } from "../db/client.js";
import { auditLog, books, jobs, users } from "../db/schema.js";
import { bookPrefix, type ObjectStorage } from "../storage.js";
import { validationHook } from "../validation.js";
import { notFound } from "./readable-book.js";

const deleteRoute = createRoute({
  method: "delete",
  path: "/books/{id}",
  summary:
    "Delete an uploaded Book in any state (PRD 4.3.6): its file, text, audio and unfinished jobs; written to the audit log",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Book deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/**
 * Deletes the user's Book, or returns false when they have no such Book.
 *
 * The rows go in one transaction with the audit entry: Chapters, Sentences, segments, jobs and Shelf entries (with
 * the user's listening progress) cascade with the Book. That frees the upload at once (the quota counts the user's
 * Books) and cancels every unfinished job: a worker still holding one learns it at its next heartbeat or report
 * (409) and drops it; the deletion waits for a report already in flight, which locks the job row.
 * The Book's objects (original, cover, audio) go after the commit, so a failure there never leaves a Book whose
 * audio is half gone; any object a worker writes afterwards is removed when its report is refused
 * (discardDeletedJobSegments).
 *
 * Future data hanging off a Book follows the same rule (PRD 4.3.6): Marks and Explanations cascade with it, while
 * Cards keep their own copy of the Sentence and the Book's title and only lose the link.
 */
export async function deleteBook(db: Db, storage: ObjectStorage, bookId: string, userId: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    const [book] = await tx
      .select({ title: books.title, email: users.email })
      .from(books)
      .innerJoin(users, eq(users.id, books.ownerId))
      .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
      .for("update", { of: books });
    if (!book) return false;
    await tx.delete(books).where(eq(books.id, bookId));
    await tx.insert(auditLog).values({
      actor: book.email,
      action: "book_delete",
      target: `${bookId} 《${book.title}》`,
      result: "deleted",
    });
    return true;
  });
  if (!deleted) return false;
  try {
    await storage.deletePrefix(bookPrefix(bookId));
  } catch (err) {
    // The Book is gone for the user either way; the leftover objects are only reachable through the log.
    console.error(`book_delete: objects of book ${bookId} not deleted`, err);
  }
  return true;
}

/** The keys a render claim of `jobId` may write (storage.audioPrefix): books/{book}/audio/{chapter}/{jobId}-{attempt}/. */
function claimKey(jobId: string, attempt: number) {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return new RegExp(`^books/${uuid}/audio/${uuid}/${jobId}-${attempt}/[^/]+$`);
}

/**
 * Called when a render report was refused. If the job no longer exists, it was cancelled while the worker was
 * rendering: its Book was deleted (after the Book's objects were), or its Voice change was dropped
 * (jobs/voice-change.ts failVoiceChange). Nothing will ever play the segments it reports: delete them too.
 * A job that still exists (finished, or claimed again) keeps its objects; published segments may be in use.
 */
export async function discardDeletedJobSegments(
  db: Db,
  storage: ObjectStorage,
  jobId: string,
  attempt: number,
  keys: string[],
) {
  if (keys.length === 0) return;
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
  if (job) return;
  const ours = claimKey(jobId, attempt);
  try {
    await storage.deleteObjects(keys.filter((k) => ours.test(k)));
  } catch (err) {
    // The worker still has to hear 409 so it drops the job; the leftovers are only reachable through the log.
    console.error(`book_delete: segments of deleted job ${jobId} not deleted`, err);
  }
}

/** The user's delete route. */
export function deleteBookRoutes({ db, storage }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });
  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await deleteBook(db, storage, id, c.get("userId")))) return c.json(notFound, 404);
    return c.body(null, 204);
  });
  return app;
}
