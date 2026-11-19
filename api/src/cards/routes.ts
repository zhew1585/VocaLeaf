// Routes of Cards (PRD 4.5.2, F12, F14, F16): making one, a Book's Cards, the Card list, a Card's audio, generating its
// back again, deleting one. Review (#16) builds on these and on cards.ts.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDeps } from "../app.js";
import type { UserEnv } from "../auth/session.js";
import { notFound } from "../books/readable-book.js";
import { onShelf } from "../books/shelf.js";
import { CARD_BACK_FAILED_MESSAGE, CardListItemSchema, CardSchema, CreateCardSchema, ErrorSchema } from "../contract.js";
import { validationHook } from "../validation.js";
import { bookCards, createCard, deleteCard, ownCard, regenerateBack, userCards } from "./cards.js";

const sentenceNotFound = { error: { code: "not_found", message: "句子不存在" } } as const;
const cardNotFound = { error: { code: "not_found", message: "卡片不存在" } } as const;
const noWords = { error: { code: "no_words", message: "选中的文字里没有单词" } } as const;
const backFailed = { error: { code: "card_back_failed", message: CARD_BACK_FAILED_MESSAGE } } as const;
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } });

const createRouteDef = createRoute({
  method: "post",
  path: "/cards",
  summary: "Make a Card of a selection of a Sentence (PRD 4.5.2), or find the one of the same Target",
  request: { body: { required: true, content: json(CreateCardSchema) } },
  responses: {
    201: { description: "Made: snapshot, audio and back (null when generating it failed)", content: json(CardSchema) },
    200: { description: "The Sentence already has a Card of this Target (PRD 4.5.2 规则 3)", content: json(CardSchema) },
    400: { description: "The selection holds no word", content: json(ErrorSchema) },
    404: { description: "No such Sentence on the user's Shelf", content: json(ErrorSchema) },
    409: {
      description: "code duplicate_target: the user has a Card of the same Target in another Sentence; send allowDuplicate to make it anyway",
      content: json(ErrorSchema),
    },
  },
});

const bookCardsRoute = createRoute({
  method: "get",
  path: "/books/{id}/cards",
  summary: "The user's Cards of the Book's Sentences in reading order (the reading view's green underlines)",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Cards", content: json(z.array(CardSchema)) },
    404: { description: "Not on the user's Shelf", content: json(ErrorSchema) },
  },
});

const audioRoute = createRoute({
  method: "get",
  path: "/cards/{id}/audio",
  summary: "The Card's own copy of its Sentence's audio (AAC in ADTS), kept when it was made (AC-CARD-07)",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Audio", content: { "audio/aac": { schema: z.string().openapi({ format: "binary" }) } } },
    404: { description: "No such Card, or it has no audio", content: json(ErrorSchema) },
  },
});

const backRoute = createRoute({
  method: "post",
  path: "/cards/{id}/back",
  summary:
    "Generate the Card's back again (【释义生成失败，点击重试】, 【重新生成】 in the Card list); not counted against the daily AI limit, its next Review unchanged",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "The Card with its new back", content: json(CardSchema) },
    404: { description: "No such Card", content: json(ErrorSchema) },
    502: { description: "Generating failed again; the Card is unchanged", content: json(ErrorSchema) },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/cards",
  summary: "Every Card of the user, soonest due first (卡片列表, F14); searching and filtering by Book is the client's",
  responses: { 200: { description: "Cards", content: json(z.array(CardListItemSchema)) } },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/cards/{id}",
  summary: "Delete a Card and its audio for good (PRD 4.5.2 删除); its Sentence's Mark stays as it is",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Deleted" },
    404: { description: "No such Card", content: json(ErrorSchema) },
  },
});

/** The duplicate prompt (PRD 4.5.2 规则 4). */
function duplicateTarget(targetText: string) {
  return { error: { code: "duplicate_target", message: `你已有 "${targetText}" 的卡片，仍要创建吗？` } };
}

export function cardRoutes({ db, storage, ai, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(createRouteDef, async (c) => {
    const outcome = await createCard({ db, storage, ai }, c.get("userId"), c.req.valid("json"), now());
    switch (outcome.result) {
      case "created":
        return c.json(outcome.card, 201);
      case "existing":
        return c.json(outcome.card, 200);
      case "duplicate":
        return c.json(duplicateTarget(outcome.targetText), 409);
      case "no_words":
        return c.json(noWords, 400);
      case "not_found":
        return c.json(sentenceNotFound, 404);
    }
  });

  app.openapi(bookCardsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    if (!(await onShelf(db, userId, id))) return c.json(notFound, 404);
    return c.json(await bookCards(db, userId, id), 200);
  });

  app.openapi(listRoute, async (c) => c.json(await userCards(db, c.get("userId")), 200));

  app.openapi(deleteRoute, async (c) => {
    if (!(await deleteCard({ db, storage }, c.get("userId"), c.req.valid("param").id))) return c.json(cardNotFound, 404);
    return c.body(null, 204);
  });

  app.openapi(audioRoute, async (c) => {
    const card = await ownCard(db, c.get("userId"), c.req.valid("param").id);
    const bytes = card?.audioKey ? await storage.getObject(card.audioKey) : undefined;
    if (!bytes) return c.json(cardNotFound, 404);
    // A Card's audio never changes once made.
    return c.body(new Uint8Array(bytes).buffer, 200, { "Content-Type": "audio/aac", "Cache-Control": "private, max-age=31536000, immutable" });
  });

  app.openapi(backRoute, async (c) => {
    const card = await ownCard(db, c.get("userId"), c.req.valid("param").id);
    if (!card) return c.json(cardNotFound, 404);
    const updated = await regenerateBack({ db, ai }, card);
    return updated ? c.json(updated, 200) : c.json(backFailed, 502);
  });

  return app;
}
