// Functional tests of the Card list (#17, PRD 4.5.2, F14) through the HTTP API: listing every Card of the user with
// where it came from, generating a back again without touching its schedule, and deleting a Card with its audio.
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DAILY_AI_CALLS, type ApiError, type BookDetail, type Card, type CardListItem, type ParseResult } from "../src/contract.js";
import { allowlist, cards, marks, shelfEntries } from "../src/db/schema.js";
import { cardAudioKey } from "../src/storage.js";
import { generatedBook, logIn, testApp, withCookie, type TestApp } from "./helpers.js";
import { fakeTsSegment } from "./ts-fixture.js";

type T = Awaited<ReturnType<typeof testApp>>;
const s = (text: string) => ({ paragraphIndex: 0, text, spokenText: text });
const chapter = (...texts: string[]): ParseResult["chapters"] => [{ title: "I", sentences: texts.map(s) }];

interface BookOf {
  book: BookDetail;
  ids: string[];
  texts: string[];
}

/** A generated Book whose Sentences have real (fake-AAC) audio, so its Cards get their own copy. */
async function book(t: T, title: string, ...texts: string[]): Promise<BookOf> {
  const detail = await generatedBook(t, title, chapter(...texts), (sentence, ms) => fakeTsSegment(ms, sentence.index));
  const res = await t.app.request(`/api/chapters/${detail.chapters[0]!.id}/sentences`);
  const sentences = (await res.json()) as { id: string; text: string }[];
  return { book: detail, ids: sentences.map((x) => x.id), texts: sentences.map((x) => x.text) };
}

/** Makes a Card of the first occurrence of `selected` in Sentence `index`. */
async function makeCard(app: TestApp, b: BookOf, index: number, selected: string): Promise<Card> {
  const start = b.texts[index]!.indexOf(selected);
  const res = await app.request("/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentenceId: b.ids[index], start, end: start + selected.length, allowDuplicate: true }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Card;
}

async function listCards(app: TestApp): Promise<CardListItem[]> {
  const res = await app.request("/api/cards");
  expect(res.status).toBe(200);
  return (await res.json()) as CardListItem[];
}

const deleteCard = (app: TestApp, id: string) => app.request(`/api/cards/${id}`, { method: "DELETE" });

async function otherUser(t: T): Promise<TestApp> {
  await t.db.insert(allowlist).values({ email: "other@example.com" });
  return withCookie(t.anon, await logIn(t, "other@example.com"));
}

describe("GET /api/cards (卡片列表, F14)", () => {
  it("lists every Card of the user across Books, soonest due first, each with the Book it is from", async () => {
    const t = await setUp();
    const { pride, walden } = t;
    const granted = await makeCard(t.app, pride, 0, "granted");
    t.clock.advance(60_000);
    const pond = await makeCard(t.app, walden, 0, "pond");
    t.clock.advance(60_000);
    const bakery = await makeCard(t.app, pride, 1, "bakery");
    // Reviewed meanwhile (#16 owns how): granted is due in three days.
    await t.db.update(cards).set({ due: new Date("2026-11-21T00:00:00Z") }).where(eq(cards.id, granted.id));

    const listed = await listCards(t.app);

    // A new Card is due when made.
    expect(listed.map((c) => c.targetText)).toEqual(["pond", "bakery", "granted"]);
    expect(listed[0]).toEqual({ ...pond, bookId: walden.book.id });
    expect(listed[1]).toEqual({ ...bakery, bookId: pride.book.id });
    expect(listed[2]).toMatchObject({ id: granted.id, bookId: pride.book.id, due: "2026-11-21T00:00:00.000Z" });
  });

  it("is empty without Cards, and never shows another user's", async () => {
    const t = await setUp();
    await makeCard(t.app, t.pride, 0, "granted");
    const other = await otherUser(t);
    expect(await listCards(other)).toEqual([]);
  });

  it("keeps a Card whose Book was deleted, without its Book, and its audio still plays (AC-CLIST-03)", async () => {
    const t = await setUp();
    const card = await makeCard(t.app, t.pride, 0, "granted");
    const audio = await (await t.app.request(`/api/cards/${card.id}/audio`)).arrayBuffer();

    expect((await t.app.request(`/api/books/${t.pride.book.id}`, { method: "DELETE" })).status).toBe(204);

    const [listed] = await listCards(t.app);
    expect(listed).toMatchObject({ id: card.id, sentenceId: null, bookId: null, bookTitle: "Pride and Prejudice" });
    const res = await t.app.request(`/api/cards/${card.id}/audio`);
    expect(res.status).toBe(200);
    expect(await res.arrayBuffer()).toEqual(audio);
  });

  it("shows a Card as without its Book once the Book is off the user's Shelf (a Library Book taken off)", async () => {
    const t = await setUp();
    const card = await makeCard(t.app, t.walden, 0, "pond");
    await t.db.delete(shelfEntries).where(eq(shelfEntries.bookId, t.walden.book.id));

    const [listed] = await listCards(t.app);
    expect(listed).toMatchObject({ id: card.id, sentenceId: t.walden.ids[0], bookId: null, bookTitle: "Walden" });
  });
});

describe("POST /api/cards/{id}/back as 【重新生成】 (AC-CLIST-04)", () => {
  it("replaces the back, keeping the next Review and the AI allowance", async () => {
    const t = await setUp();
    const card = await makeCard(t.app, t.pride, 0, "granted");
    const due = new Date("2026-11-25T00:00:00Z");
    await t.db.update(cards).set({ due, back: { kind: "word", meaning: "旧释义", phonetic: "", partOfSpeech: "", collocations: [] } }).where(eq(cards.id, card.id));

    const res = await t.app.request(`/api/cards/${card.id}/back`, { method: "POST" });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as Card;
    expect(updated.back).toMatchObject({ kind: "word", meaning: "（示例释义）granted" });
    expect(updated.due).toBe(due.toISOString());
    const [listed] = await listCards(t.app);
    expect(listed).toMatchObject({ back: updated.back, due: due.toISOString() });
    const usage = (await (await t.app.request("/api/me/usage")).json()) as { aiRemaining: number };
    expect(usage.aiRemaining).toBe(DAILY_AI_CALLS);
  });
});

describe("DELETE /api/cards/{id} (删除, PRD 4.5.2)", () => {
  it("deletes the Card and its audio for good; its Sentence loses the underline and keeps its Mark", async () => {
    const t = await setUp();
    // Marked, then made into a Card: the Mark is processed (PRD 4.4.4).
    expect((await t.app.request(`/api/sentences/${t.pride.ids[0]}/mark`, { method: "PUT" })).status).toBe(200);
    const card = await makeCard(t.app, t.pride, 0, "granted");
    const kept = await makeCard(t.app, t.pride, 1, "bakery");
    expect(t.storage.objects.has(cardAudioKey(card.id))).toBe(true);

    const res = await deleteCard(t.app, card.id);

    expect(res.status).toBe(204);
    expect((await listCards(t.app)).map((c) => c.id)).toEqual([kept.id]);
    const underlined = (await (await t.app.request(`/api/books/${t.pride.book.id}/cards`)).json()) as Card[];
    expect(underlined.map((c) => c.id)).toEqual([kept.id]);
    expect(t.storage.objects.has(cardAudioKey(card.id))).toBe(false);
    expect(t.storage.objects.has(cardAudioKey(kept.id))).toBe(true);
    expect((await t.app.request(`/api/cards/${card.id}/audio`)).status).toBe(404);
    expect((await t.app.request(`/api/cards/${card.id}/back`, { method: "POST" })).status).toBe(404);
    // The Mark stays processed: deleting a Card never puts its Sentence back into Gleanings (PRD 4.5.2 删除).
    const [mark] = await t.db.select().from(marks).where(and(eq(marks.sentenceId, t.pride.ids[0]!)));
    expect(mark?.status).toBe("processed");
    expect(((await (await t.app.request("/api/gleanings/count")).json()) as { count: number }).count).toBe(0);
    expect((await deleteCard(t.app, card.id)).status).toBe(404);
  });

  it("deletes a Card whose Book is gone, and a Card made without audio", async () => {
    const t = await setUp();
    const card = await makeCard(t.app, t.pride, 0, "granted");
    await t.app.request(`/api/books/${t.pride.book.id}`, { method: "DELETE" });
    await t.db.update(cards).set({ audioKey: null }).where(eq(cards.id, card.id));

    expect((await deleteCard(t.app, card.id)).status).toBe(204);
    expect(await listCards(t.app)).toEqual([]);
  });

  it("is 404 for another user's Card, which stays", async () => {
    const t = await setUp();
    const card = await makeCard(t.app, t.pride, 0, "granted");
    const other = await otherUser(t);

    const res = await deleteCard(other, card.id);

    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("not_found");
    expect((await listCards(t.app)).map((c) => c.id)).toEqual([card.id]);
    expect(t.storage.objects.has(cardAudioKey(card.id))).toBe(true);
  });
});

async function setUp() {
  const t = await testApp();
  const pride = await book(t, "Pride and Prejudice", "She took it for granted that he would come.", "She runs a bakery in the village.");
  const walden = await book(t, "Walden", "I went down to the pond.");
  return { ...t, pride, walden };
}
