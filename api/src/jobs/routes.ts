import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, sql } from "drizzle-orm";
import { bearerAuth } from "hono/bearer-auth";
import type { AppDeps } from "../app.js";
import {
  ClaimedJobSchema,
  ErrorSchema,
  JobFailureSchema,
  ParseResultSchema,
  type ParseResult,
} from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, jobs, sentences } from "../db/schema.js";
import { sourceKey } from "../storage.js";
import { validationHook } from "../validation.js";

const security = [{ workerToken: [] }];
const jobParams = z.object({ id: z.uuid() });
const conflict = {
  description: "Job is not running",
  content: { "application/json": { schema: ErrorSchema } },
};

const claimRoute = createRoute({
  method: "post",
  path: "/internal/jobs/claim",
  summary: "Worker claims the oldest queued job",
  security,
  responses: {
    200: { description: "Claimed job", content: { "application/json": { schema: ClaimedJobSchema } } },
    204: { description: "No job queued" },
  },
});

const parseResultRoute = createRoute({
  method: "post",
  path: "/internal/jobs/{id}/parse-result",
  summary: "Worker reports the Chapters and Sentences of a parsed Book",
  security,
  request: {
    params: jobParams,
    body: { required: true, content: { "application/json": { schema: ParseResultSchema } } },
  },
  responses: { 204: { description: "Stored" }, 409: conflict },
});

const failureRoute = createRoute({
  method: "post",
  path: "/internal/jobs/{id}/failure",
  summary: "Worker reports that a job failed",
  security,
  request: {
    params: jobParams,
    body: { required: true, content: { "application/json": { schema: JobFailureSchema } } },
  },
  responses: { 204: { description: "Recorded" }, 409: conflict },
});

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Postgres caps bind parameters at 65535 per statement; 6 columns per sentence row. */
const SENTENCE_INSERT_CHUNK = 5000;

/** Locks a running job for the rest of the transaction, or returns undefined. */
async function lockRunningJob(tx: Tx, id: string) {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .for("update");
  return job;
}

/** Saves a parse result; the Book then moves from parsing to generating (PRD 4.3.4 step 3). */
async function storeParseResult(tx: Tx, bookId: string, result: ParseResult) {
  const inserted = await tx
    .insert(chapters)
    .values(
      result.chapters.map((ch, index) => ({
        bookId,
        index,
        // PRD 4.2.5: a Chapter without a TOC title is named 第 N 章.
        title: ch.title?.trim() || `第 ${index + 1} 章`,
      })),
    )
    .returning({ id: chapters.id, index: chapters.index });

  const rows = inserted.flatMap(({ id, index }) =>
    result.chapters[index]!.sentences.map((s, i) => ({ chapterId: id, index: i, ...s })),
  );
  for (let i = 0; i < rows.length; i += SENTENCE_INSERT_CHUNK) {
    await tx.insert(sentences).values(rows.slice(i, i + SENTENCE_INSERT_CHUNK));
  }

  await tx
    .update(books)
    .set({
      status: "generating",
      parserVersion: result.parserVersion,
      ...(result.title?.trim() ? { title: result.title.trim() } : {}),
      author: result.author?.trim() || null,
    })
    .where(eq(books.id, bookId));
}

/** Routes the stateless worker uses to pull jobs and report results (ADR 0002, 0003). */
export function jobRoutes({ db, workerToken }: AppDeps) {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.use("/internal/*", bearerAuth({ token: workerToken }));

  app.openapi(claimRoute, async (c) => {
    const job = await db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!next) return undefined;
      const [claimed] = await tx
        .update(jobs)
        .set({ status: "running", attempt: sql`${jobs.attempt} + 1`, updatedAt: new Date() })
        .where(eq(jobs.id, next.id))
        .returning();
      return claimed;
    });
    if (!job) return c.body(null, 204);
    return c.json({ id: job.id, type: job.type, bookId: job.bookId, sourceKey: sourceKey(job.bookId) }, 200);
  });

  app.openapi(parseResultRoute, async (c) => {
    const { id } = c.req.valid("param");
    const result = c.req.valid("json");
    const stored = await db.transaction(async (tx) => {
      const job = await lockRunningJob(tx, id);
      if (!job || job.type !== "parse") return false;
      await storeParseResult(tx, job.bookId, result);
      await tx.update(jobs).set({ status: "succeeded", updatedAt: new Date() }).where(eq(jobs.id, id));
      return true;
    });
    if (!stored) return c.json({ error: { code: "job_not_running", message: "Job is not running" } }, 409);
    return c.body(null, 204);
  });

  app.openapi(failureRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { error } = c.req.valid("json");
    const recorded = await db.transaction(async (tx) => {
      const job = await lockRunningJob(tx, id);
      if (!job) return false;
      await tx.update(jobs).set({ status: "failed", error, updatedAt: new Date() }).where(eq(jobs.id, id));
      // Failure reasons and their messages (PRD 4.3.5 #4 to #6) come with #3.
      if (job.type === "parse") {
        await tx.update(books).set({ status: "parse_failed" }).where(eq(books.id, job.bookId));
      }
      return true;
    });
    if (!recorded) return c.json({ error: { code: "job_not_running", message: "Job is not running" } }, 409);
    return c.body(null, 204);
  });

  return app;
}
