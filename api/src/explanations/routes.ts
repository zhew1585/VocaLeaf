// 句子精读's AI (PRD 4.5.1, F11): a Sentence's Explanation and follow-up questions, private to each user.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, between, eq, sql } from "drizzle-orm";
import type { AiRequest } from "../ai/provider.js";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import {
  AI_FAILED_MESSAGE,
  AI_QUOTA_MESSAGE,
  ErrorSchema,
  ExplainRequestSchema,
  ExplanationSchema,
  type ChatMessage,
  type ExplainEvent,
} from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, explanations, sentences } from "../db/schema.js";
import { validationHook } from "../validation.js";
import { askRequest, explainRequest, type SentenceContext } from "./prompt.js";
import { aiCallsLeft, beijingDay, returnAiCall, takeAiCall } from "./quota.js";

const sentenceNotFound = { error: { code: "not_found", message: "句子不存在" } } as const;
const quotaExhausted = { error: { code: "ai_quota_exhausted", message: AI_QUOTA_MESSAGE } } as const;

const getRoute = createRoute({
  method: "get",
  path: "/sentences/{id}/explanation",
  summary: "The user's Explanation of a Sentence with its follow-up questions, and today's AI calls left",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Explanation", content: { "application/json": { schema: ExplanationSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const postRoute = createRoute({
  method: "post",
  path: "/sentences/{id}/explanation",
  summary: "Generates the Sentence's Explanation (again) or answers a follow-up question, streamed as NDJSON events",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { required: true, content: { "application/json": { schema: ExplainRequestSchema } } },
  },
  responses: {
    200: {
      description: "ExplainEvent lines: deltas, then done or error",
      content: { "application/x-ndjson": { schema: z.string() } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "No AI calls left today", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** The user's Sentence with the paragraphs around it and its Book, or undefined when it is not theirs. */
async function loadContext(db: Db, sentenceId: string, userId: string): Promise<SentenceContext | undefined> {
  const [row] = await db
    .select({
      text: sentences.text,
      chapterId: sentences.chapterId,
      paragraphIndex: sentences.paragraphIndex,
      bookTitle: books.title,
      author: books.author,
    })
    .from(sentences)
    .innerJoin(chapters, eq(chapters.id, sentences.chapterId))
    .innerJoin(books, eq(books.id, chapters.bookId))
    .where(and(eq(sentences.id, sentenceId), eq(books.ownerId, userId)));
  if (!row) return undefined;
  const near = await db
    .select({ paragraphIndex: sentences.paragraphIndex, text: sentences.text })
    .from(sentences)
    .where(and(eq(sentences.chapterId, row.chapterId), between(sentences.paragraphIndex, row.paragraphIndex - 1, row.paragraphIndex + 1)))
    .orderBy(asc(sentences.index));
  const paragraph = (index: number) => {
    const texts = near.filter((s) => s.paragraphIndex === index).map((s) => s.text);
    return texts.length > 0 ? texts.join(" ") : null;
  };
  return {
    bookTitle: row.bookTitle,
    author: row.author,
    sentence: row.text,
    before: paragraph(row.paragraphIndex - 1),
    paragraph: paragraph(row.paragraphIndex)!,
    after: paragraph(row.paragraphIndex + 1),
  };
}

async function loadExplanation(db: Db, userId: string, sentenceId: string) {
  const [row] = await db
    .select({ content: explanations.content, messages: explanations.messages })
    .from(explanations)
    .where(and(eq(explanations.userId, userId), eq(explanations.sentenceId, sentenceId)));
  return row ?? { content: null, messages: [] };
}

/** Saves a finished Explanation, replacing the old one and keeping the follow-ups. */
async function saveExplanation(db: Db, key: { userId: string; sentenceId: string }, content: string, model: string, now: Date) {
  await db
    .insert(explanations)
    .values({ ...key, content, model, updatedAt: now })
    .onConflictDoUpdate({ target: [explanations.userId, explanations.sentenceId], set: { content, model, updatedAt: now } });
}

/** Appends a question and its answer; appended in SQL so answers finishing together do not drop each other. */
async function appendMessages(db: Db, key: { userId: string; sentenceId: string }, turns: ChatMessage[], model: string, now: Date) {
  await db
    .insert(explanations)
    .values({ ...key, messages: turns, model, updatedAt: now })
    .onConflictDoUpdate({
      target: [explanations.userId, explanations.sentenceId],
      set: { messages: sql`${explanations.messages} || ${JSON.stringify(turns)}::jsonb`, model, updatedAt: now },
    });
}

/** GET and POST /sentences/{id}/explanation. */
export function explanationRoutes({ db, ai, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    if (!(await loadContext(db, id, userId))) return c.json(sentenceNotFound, 404);
    const saved = await loadExplanation(db, userId, id);
    return c.json({ ...saved, aiRemaining: await aiCallsLeft(db, userId, beijingDay(now())) }, 200);
  });

  app.openapi(postRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const userId = c.get("userId");
    const ctx = await loadContext(db, id, userId);
    if (!ctx) return c.json(sentenceNotFound, 404);

    let request: AiRequest;
    if (body.kind === "explain") request = explainRequest(ctx);
    else {
      const saved = await loadExplanation(db, userId, id);
      request = askRequest(ctx, saved.content, saved.messages, body.question);
    }
    const day = beijingDay(now());
    if (!(await takeAiCall(db, userId, day))) return c.json(quotaExhausted, 429);

    const key = { userId, sentenceId: id };
    // Stopped when the client stops reading (【停止】) or goes away; switching Sentences keeps reading (#9).
    const stop = new AbortController();
    const encoder = new TextEncoder();
    let open = true;
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const send = (event: ExplainEvent) => {
      if (!open) return;
      try {
        out.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      } catch {
        open = false;
      }
    };
    const close = () => {
      if (open) out.close();
      open = false;
    };

    /** Streams the answer, then saves it (a stopped one counts; a failed one is given back and not saved). */
    const run = async () => {
      let text = "";
      try {
        for await (const chunk of ai.stream(request, stop.signal)) {
          text += chunk;
          send({ type: "delta", text: chunk });
        }
      } catch (err) {
        if (!stop.signal.aborted) {
          console.error(`AI call for Sentence ${id} failed`, err);
          await returnAiCall(db, userId, day);
          send({ type: "error", message: AI_FAILED_MESSAGE });
          return close();
        }
      }
      const stopped = stop.signal.aborted;
      // A stopped Explanation is not the Sentence's Explanation (PRD 4.5.1 #7); a stopped answer keeps what it said.
      if (body.kind === "explain" && !stopped) await saveExplanation(db, key, text, ai.model, now());
      if (body.kind === "ask" && (text !== "" || !stopped)) {
        await appendMessages(db, key, [{ role: "user", content: body.question }, { role: "assistant", content: text }], ai.model, now());
      }
      send({ type: "done", aiRemaining: await aiCallsLeft(db, userId, day) });
      close();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        out = controller;
        void run().catch((err: unknown) => {
          console.error(`Saving the AI answer for Sentence ${id} failed`, err);
          send({ type: "error", message: AI_FAILED_MESSAGE });
          close();
        });
      },
      cancel() {
        open = false;
        stop.abort();
      },
    });
    c.req.raw.signal.addEventListener("abort", () => stop.abort(), { once: true });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
    }) as never;
  });

  return app;
}
