import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerAuth } from "hono/bearer-auth";
import type { AppDeps } from "../app.js";
import {
  ClaimedJobSchema,
  ErrorSchema,
  HeartbeatSchema,
  JobFailureSchema,
  ParseResultSchema,
  RenderReportSchema,
  type ClaimedJob,
} from "../contract.js";
import { sourceKey } from "../storage.js";
import { validationHook } from "../validation.js";
import { claimNextJob, failAttempt, lockCurrentAttempt, renewLease, succeedJob, type Job, type Tx } from "./lifecycle.js";
import { storeParseResult } from "./parse.js";
import { finishRender, startRender, storeRenderReport } from "./render.js";

const security = [{ workerToken: [] }];
const jobParams = z.object({ id: z.uuid() });
const jobNotRunning = {
  error: { code: "job_not_running", message: "Job is not running under this attempt" },
} as const;
const conflict = {
  description: "Job is not running under this attempt: finished, failed, or claimed again since",
  content: { "application/json": { schema: ErrorSchema } },
};

function report<S extends z.ZodType>(path: string, summary: string, schema: S) {
  return createRoute({
    method: "post",
    path: `/internal/jobs/{id}/${path}`,
    summary,
    security,
    request: { params: jobParams, body: { required: true, content: { "application/json": { schema } } } },
    responses: { 204: { description: "Accepted" }, 409: conflict },
  });
}

const claimRoute = createRoute({
  method: "post",
  path: "/internal/jobs/claim",
  summary: "Worker claims the next job",
  security,
  responses: {
    200: { description: "Claimed job", content: { "application/json": { schema: ClaimedJobSchema } } },
    204: { description: "No job queued" },
  },
});

const parseResultRoute = report("parse-result", "Worker reports the Chapters and Sentences of a parsed Book", ParseResultSchema);
const heartbeatRoute = report("heartbeat", "Worker is still working on the job; extends its lease", HeartbeatSchema);
const renderProgressRoute = report(
  "render-progress",
  "Worker reports segments and Sentence timings rendered so far; the Chapter keeps generating",
  RenderReportSchema,
);
const renderResultRoute = report(
  "render-result",
  "Worker reports the last segments and Sentence timings of a Chapter and finishes it",
  RenderReportSchema,
);
const failureRoute = report(
  "failure",
  "Worker reports that its attempt failed; a Chapter with attempts left is queued again",
  JobFailureSchema,
);

/** Routes the stateless worker uses to pull jobs and report results (ADR 0002, 0003). */
export function jobRoutes({ db, workerToken, jobLeaseMs, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.use("/internal/*", bearerAuth({ token: workerToken }));

  /**
   * Runs `fn` on the job if it is still running under `attempt` and of the expected type;
   * answers 204 when it ran and 409 when the claim is no longer current.
   */
  const withCurrentJob = async (
    id: string,
    attempt: number,
    type: Job["type"] | null,
    fn: (tx: Tx, job: Job) => Promise<void>,
  ) =>
    db.transaction(async (tx) => {
      const job = await lockCurrentAttempt(tx, id, attempt);
      if (!job || (type && job.type !== type)) return false;
      await fn(tx, job);
      return true;
    });

  app.openapi(claimRoute, async (c) => {
    const claimed = await db.transaction(async (tx): Promise<ClaimedJob | undefined> => {
      const job = await claimNextJob(tx, now(), jobLeaseMs);
      if (!job) return undefined;
      const base = { id: job.id, bookId: job.bookId, attempt: job.attempt, leaseMs: jobLeaseMs };
      if (job.type === "parse") return { ...base, type: "parse", sourceKey: sourceKey(job.bookId) };
      return { ...base, type: "render_chapter", ...(await startRender(tx, job)) };
    });
    if (!claimed) return c.body(null, 204);
    return c.json(claimed, 200);
  });

  app.openapi(parseResultRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt, ...result } = c.req.valid("json");
    const stored = await withCurrentJob(id, attempt, "parse", async (tx, job) => {
      await storeParseResult(tx, job.bookId, result);
      await succeedJob(tx, job, now());
    });
    return stored ? c.body(null, 204) : c.json(jobNotRunning, 409);
  });

  app.openapi(heartbeatRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt } = c.req.valid("json");
    const renewed = await withCurrentJob(id, attempt, null, (tx, job) => renewLease(tx, job, now(), jobLeaseMs));
    return renewed ? c.body(null, 204) : c.json(jobNotRunning, 409);
  });

  app.openapi(renderProgressRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt, ...body } = c.req.valid("json");
    const stored = await withCurrentJob(id, attempt, "render_chapter", (tx, job) => storeRenderReport(tx, job, body));
    return stored ? c.body(null, 204) : c.json(jobNotRunning, 409);
  });

  app.openapi(renderResultRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt, ...body } = c.req.valid("json");
    const stored = await withCurrentJob(id, attempt, "render_chapter", async (tx, job) => {
      await storeRenderReport(tx, job, body);
      await finishRender(tx, job, now());
    });
    return stored ? c.body(null, 204) : c.json(jobNotRunning, 409);
  });

  app.openapi(failureRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt, error, reason } = c.req.valid("json");
    const recorded = await withCurrentJob(id, attempt, null, (tx, job) => failAttempt(tx, job, error, now(), reason));
    return recorded ? c.body(null, 204) : c.json(jobNotRunning, 409);
  });

  return app;
}
