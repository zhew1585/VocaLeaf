// Routes of Marks and Gleanings (PRD 4.4.2, 4.4.4, F8, F10).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { onShelf } from "../books/shelf.js";
import { notFound } from "../books/own-book.js";
import { BookMarksSchema, ErrorSchema, GleaningCountSchema, GleaningSchema, MarkResultSchema } from "../contract.js";
import { validationHook } from "../validation.js";
import {
  dismissMark,
  gleaningCount,
  loadGleanings,
  markSentence,
  pendingInBook,
  unmarkSentence,
} from "./marks.js";

const sentenceNotFound = { error: { code: "not_found", message: "句子不存在" } } as const;
const markNotFound = { error: { code: "not_found", message: "这一句没有标记" } } as const;
const sentenceParams = z.object({ id: z.uuid() });

const markRoute = createRoute({
  method: "put",
  path: "/sentences/{id}/mark",
  summary: "Mark a Sentence (PRD 4.4.2): create a pending Mark, or put a processed or dismissed one back to pending",
  request: { params: sentenceParams },
  responses: {
    200: { description: "What marking did", content: { "application/json": { schema: MarkResultSchema } } },
    404: { description: "No such Sentence on the user's Shelf", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const unmarkRoute = createRoute({
  method: "delete",
  path: "/sentences/{id}/mark",
  summary: "Delete the user's Mark of a Sentence (undo, 取消标记); deleting a missing Mark does nothing",
  request: { params: sentenceParams },
  responses: { 204: { description: "No Mark left" } },
});

const dismissRoute = createRoute({
  method: "post",
  path: "/sentences/{id}/mark/dismiss",
  summary: "Dismiss a pending Mark (PRD 4.4.4): it leaves Gleanings as 已忽略",
  request: { params: sentenceParams },
  responses: {
    204: { description: "Dismissed" },
    404: { description: "The user has no Mark on the Sentence", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const bookMarksRoute = createRoute({
  method: "get",
  path: "/books/{id}/marks",
  summary: "The Book's Sentences with a pending Mark of the user (the reading view's underlines)",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Pending Marks", content: { "application/json": { schema: BookMarksSchema } } },
    404: { description: "Not on the user's Shelf", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const gleaningsRoute = createRoute({
  method: "get",
  path: "/gleanings",
  summary: "The user's Gleanings: pending Marks across Books, most recently marked first (PRD 4.4.4)",
  responses: {
    200: { description: "Gleanings", content: { "application/json": { schema: z.array(GleaningSchema) } } },
  },
});

const countRoute = createRoute({
  method: "get",
  path: "/gleanings/count",
  summary: "How many Sentences wait in Gleanings (the navigation's badge)",
  responses: {
    200: { description: "The count", content: { "application/json": { schema: GleaningCountSchema } } },
  },
});

export function markRoutes({ db, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(markRoute, async (c) => {
    const result = await markSentence(db, c.get("userId"), c.req.valid("param").id, now());
    return result ? c.json({ result }, 200) : c.json(sentenceNotFound, 404);
  });

  app.openapi(unmarkRoute, async (c) => {
    await unmarkSentence(db, c.get("userId"), c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.openapi(dismissRoute, async (c) => {
    const found = await dismissMark(db, c.get("userId"), c.req.valid("param").id, now());
    return found ? c.body(null, 204) : c.json(markNotFound, 404);
  });

  app.openapi(bookMarksRoute, async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    if (!(await onShelf(db, userId, id))) return c.json(notFound, 404);
    return c.json({ pending: await pendingInBook(db, userId, id) }, 200);
  });

  app.openapi(gleaningsRoute, async (c) => c.json(await loadGleanings(db, c.get("userId")), 200));

  app.openapi(countRoute, async (c) => c.json({ count: await gleaningCount(db, c.get("userId")) }, 200));

  return app;
}
