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
  type ExplainRequest,
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

/** The user's Sentence with its Book's title and author, or undefined when it is not theirs. */
async function ownSentence(db: Db, sentenceId: string, userId: string) {
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
  return row;
}

/** The user's Sentence with the paragraphs around it and its Book, or undefined when it is not theirs. */
async function loadContext(db: Db, sentenceId: string, userId: string): Promise<SentenceContext | undefined> {
  const row = await ownSentence(db, sentenceId, userId);
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
    // The Sentence is in its own paragraph, so it is never empty.
    paragraph: paragraph(row.paragraphIndex) ?? row.text,
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

interface NdjsonStream {
  stream: ReadableStream<Uint8Array>;
  /** Aborted once the reader leaves (the client stopped or went away). */
  stop: AbortController;
  send(event: ExplainEvent): void;
  close(): void;
}

/** A response body of ExplainEvent lines; writes after the reader left are dropped. */
function ndjsonStream(): NdjsonStream {
  const stop = new AbortController();
  const encoder = new TextEncoder();
  let open = true;
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => void (out = controller),
    cancel: () => {
      open = false;
      stop.abort();
    },
  });
  return {
    stream,
    stop,
    send: (event) => {
      if (!open) return;
      try {
        out.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      } catch {
        open = false;
      }
    },
    close: () => {
      if (open) out.close();
      open = false;
    },
  };
}

/** GET and POST /sentences/{id}/explanation. */
export function explanationRoutes({ db, ai, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    if (!(await ownSentence(db, id, userId))) return c.json(sentenceNotFound, 404);
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

    const reply = ndjsonStream();
    // Stopped when the client stops reading (【停止】) or goes away; switching Sentences keeps reading (AC-PANEL-14).
    c.req.raw.signal.addEventListener("abort", () => reply.stop.abort(), { once: true });
    const call: AnswerCall = { key: { userId, sentenceId: id }, day, request, body };
    void answer(call, reply).catch(async (err: unknown) => {
      // Not saved, so not counted either.
      console.error(`Saving the AI answer for Sentence ${id} failed`, err);
      await returnAiCall(db, userId, day).catch((e: unknown) => console.error("Returning the AI call failed", e));
      reply.send({ type: "error", message: AI_FAILED_MESSAGE });
      reply.close();
    });
    // A streamed body has no typed response in the route's OpenAPI types, hence the cast. X-Accel-Buffering: nginx
    // (web/nginx.conf) would otherwise hold the answer back until it is complete.
    const headers = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" };
    return new Response(reply.stream, { status: 200, headers }) as never;
  });

  interface AnswerCall {
    key: { userId: string; sentenceId: string };
    day: string;
    request: AiRequest;
    body: ExplainRequest;
  }

  /** Ends a failed AI call: given back, nothing saved (F11 异常处理). */
  async function fail(key: AnswerCall["key"], day: string, reply: NdjsonStream, err: unknown) {
    console.error(`AI call for Sentence ${key.sentenceId} failed`, err);
    await returnAiCall(db, key.userId, day);
    reply.send({ type: "error", message: AI_FAILED_MESSAGE });
    reply.close();
  }

  /** Streams the AI's answer, then saves it: a stopped one counts, a failed one is given back and not saved. */
  async function answer({ key, day, request, body }: AnswerCall, reply: NdjsonStream) {
    let text = "";
    try {
      for await (const chunk of ai.stream(request, reply.stop.signal)) {
        text += chunk;
        reply.send({ type: "delta", text: chunk });
      }
    } catch (err) {
      if (!reply.stop.signal.aborted) return fail(key, day, reply, err);
    }
    const stopped = reply.stop.signal.aborted;
    // An empty answer would also break every later question (the model refuses empty turns in the history).
    if (!stopped && text.trim() === "") return fail(key, day, reply, new Error("the AI answered nothing"));
    // A stopped Explanation is not the Sentence's Explanation (PRD 4.5.1 #7); a stopped answer keeps what it said.
    if (body.kind === "explain" && !stopped) await saveExplanation(db, key, text, ai.model, now());
    if (body.kind === "ask" && (text !== "" || !stopped)) {
      const turns: ChatMessage[] = [
        { role: "user", content: body.question },
        { role: "assistant", content: text },
      ];
      await appendMessages(db, key, turns, ai.model, now());
    }
    reply.send({ type: "done", aiRemaining: await aiCallsLeft(db, key.userId, day) });
    reply.close();
  }

  return app;
}
