// What the settings page (PRD F15) shows of the user's limits (PRD 4.7.2). Each count comes from the code that
// enforces its limit, so the page and the refusals never disagree.
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { uploadedBooks } from "../books/upload-routes.js";
import { DAILY_AI_CALLS, MAX_UPLOADED_BOOKS, UsageSchema } from "../contract.js";
import { aiCallsLeft, beijingDay } from "../explanations/quota.js";
import { validationHook } from "../validation.js";

const usageRoute = createRoute({
  method: "get",
  path: "/me/usage",
  summary: "Today's AI calls left and the uploaded Books held, against their limits (设置页, AC-SET-01)",
  responses: {
    200: { description: "The user's usage", content: { "application/json": { schema: UsageSchema } } },
  },
});

export function usageRoutes({ db, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(usageRoute, async (c) => {
    const userId = c.get("userId");
    const [aiRemaining, uploaded] = await Promise.all([
      aiCallsLeft(db, userId, beijingDay(now())),
      uploadedBooks(db, userId),
    ]);
    return c.json(
      { aiRemaining, aiDailyLimit: DAILY_AI_CALLS, uploadedBooks: uploaded, maxUploadedBooks: MAX_UPLOADED_BOOKS },
      200,
    );
  });

  return app;
}
