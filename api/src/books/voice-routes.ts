// The user changes a Book's Voice (PRD 4.2.4, F5 更换音色). The work itself is in jobs/voice-change.ts.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { ChangeVoiceSchema, ErrorSchema } from "../contract.js";
import { books } from "../db/schema.js";
import { startVoiceChange, type VoiceChangeRefusal } from "../jobs/voice-change.js";
import { validationHook } from "../validation.js";
import { notFound } from "./readable-book.js";

const json = { "application/json": { schema: ErrorSchema } };

const changeVoiceRoute = createRoute({
  method: "post",
  path: "/books/{id}/voice",
  summary:
    "Generate the Book's audio again in another Voice; the old audio plays until the new one is complete (PRD 4.2.4)",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { required: true, content: { "application/json": { schema: ChangeVoiceSchema } } },
  },
  responses: {
    202: { description: "Voice change started; the Book detail shows it as running" },
    403: { description: "A Library Book keeps its Voice", content: json },
    404: { description: "Not found", content: json },
    409: {
      description: "A Voice change is running, the Book is not 已就绪 yet, or it has that Voice already",
      content: json,
    },
  },
});

const REFUSALS: Record<VoiceChangeRefusal, { status: 403 | 409; code: string; message: string }> = {
  not_changeable: { status: 403, code: "voice_not_changeable", message: "书库的书不能更换音色" },
  running: { status: 409, code: "voice_change_running", message: "正在更换音色，完成前不能再次更换" },
  not_ready: { status: 409, code: "book_not_ready", message: "这本书生成完成后才能更换音色" },
  same_voice: { status: 409, code: "same_voice", message: "这本书已经是这个音色" },
};

/** POST /books/{id}/voice. */
export function voiceRoutes({ db, storage }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(changeVoiceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { voice } = c.req.valid("json");
    const outcome = await db.transaction(async (tx) => {
      const [book] = await tx
        .select()
        .from(books)
        .where(and(eq(books.id, id), eq(books.ownerId, c.get("userId"))))
        .for("update");
      return book ? startVoiceChange(tx, book, voice) : undefined;
    });
    if (!outcome) return c.json(notFound, 404);
    if (!outcome.started) {
      const { status, code, message } = REFUSALS[outcome.refusal];
      return c.json({ error: { code, message } }, status);
    }
    try {
      await storage.deleteObjects(outcome.staleKeys);
    } catch (err) {
      // The change is under way either way; the leftovers go with the Book's other objects when it is deleted.
      console.error(`voice_change: stale segments of book ${id} not deleted`, err);
    }
    return c.body(null, 202);
  });

  return app;
}
