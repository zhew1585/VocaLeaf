// Routes of Review (PRD 4.5.3, F13): today's queue, its size for the navigation, and rating a Card.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { ErrorSchema, RateCardSchema, ReviewCountSchema, ReviewQueueSchema } from "../contract.js";
import { validationHook } from "../validation.js";
import { rateCard, reviewCount, reviewQueue } from "./queue.js";

const cardNotFound = { error: { code: "not_found", message: "卡片不存在" } } as const;
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } });

const queueRoute = createRoute({
  method: "get",
  path: "/review",
  summary: "Today's Review queue (PRD 4.5.3): due Cards plus the day's new Cards, by due date, with each rating's interval",
  responses: { 200: { description: "The queue", content: json(ReviewQueueSchema) } },
});

const countRoute = createRoute({
  method: "get",
  path: "/review/count",
  summary: "How many Cards today's Review queue holds (the navigation's 复习 badge)",
  responses: { 200: { description: "Count", content: json(ReviewCountSchema) } },
});

const rateRoute = createRoute({
  method: "post",
  path: "/cards/{id}/review",
  summary: "Rate a Card in Review (1 忘了, 2 困难, 3 记得, 4 简单) and schedule it by FSRS",
  request: { params: z.object({ id: z.uuid() }), body: { required: true, content: json(RateCardSchema) } },
  responses: {
    200: { description: "Today's queue after the rating", content: json(ReviewQueueSchema) },
    404: { description: "No such Card (deleted, or not the user's)", content: json(ErrorSchema) },
  },
});

export function reviewRoutes({ db, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(queueRoute, async (c) => c.json(await reviewQueue(db, c.get("userId"), now()), 200));

  app.openapi(countRoute, async (c) => c.json({ count: await reviewCount(db, c.get("userId"), now()) }, 200));

  app.openapi(rateRoute, async (c) => {
    const userId = c.get("userId");
    const at = now();
    if (!(await rateCard(db, userId, c.req.valid("param").id, c.req.valid("json").rating, at))) return c.json(cardNotFound, 404);
    return c.json(await reviewQueue(db, userId, at), 200);
  });

  return app;
}
