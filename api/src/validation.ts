import type { Hook } from "@hono/zod-openapi";

/** Turns request validation failures into our error envelope with HTTP 400. */
export const validationHook: Hook<unknown, any, any, unknown> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return c.json({ error: { code: "invalid_request", message } }, 400);
  }
};
