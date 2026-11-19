// End-to-end: making Cards (#15, PRD 4.5.2) on the running compose stack. The real worker renders with Kokoro, so the
// API cuts a Card's audio out of real HLS segments in RustFS; without ANTHROPIC_API_KEY the back comes from the API's
// deterministic fake (ADR 0003). Needs `npm run e2e:up`.
import { beforeAll, describe, expect, it } from "vitest";
import type { BookDetail, Card, Gleaning, Sentence } from "../api/src/contract.js";
import { api, endOpenJobs, fetchBytes, SHORT_WALK, upload, waitForBook } from "./support.js";

/** Generating both short Chapters on CPU, once per Voice. */
const GENERATE_MS = 240_000;

function postJson<T>(path: string, body: unknown) {
  return api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** The AAC frames of an ADTS stream; throws on anything else. */
function adtsFrames(bytes: Uint8Array): number {
  let frames = 0;
  for (let at = 0; at < bytes.length; frames++) {
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xf6) !== 0xf0) throw new Error(`no ADTS frame at byte ${at}`);
    at += ((bytes[at + 3]! & 3) << 11) | (bytes[at + 4]! << 3) | (bytes[at + 5]! >> 5);
  }
  return frames;
}

describe("Cards through the stack", () => {
  beforeAll(() => endOpenJobs());

  it("makes a Card with its own copy of the Sentence's audio, which survives a Voice change (AC-CARD-07)", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK);
    expect(created.status).toBe(201);
    const id = created.body.id;
    const ready = await waitForBook(id, (b) => b.status === "ready", GENERATE_MS);
    const chapter = ready.chapters.find((c) => !c.skipped)!;
    const sentence = (await api<Sentence[]>(`/chapters/${chapter.id}/sentences`)).body.find((s) => /\w+ \w+/.test(s.text))!;

    // Marked first: making the Card takes it out of Gleanings (AC-CARD-06).
    expect((await api(`/sentences/${sentence.id}/mark`, { method: "PUT" })).status).toBe(200);
    const word = /[A-Za-z]{3,}/.exec(sentence.text)!;
    const made = await postJson<Card>("/cards", { sentenceId: sentence.id, start: word.index + 1, end: word.index + 2 });

    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ targetText: word[0], targetKind: "word", hasAudio: true, back: { kind: "word" } });
    const gleanings = (await api<Gleaning[]>("/gleanings")).body;
    expect(gleanings.map((g) => g.sentenceId)).not.toContain(sentence.id);
    expect((await api<Card[]>(`/books/${id}/cards`)).body.map((c) => c.id)).toEqual([made.body.id]);

    const audio = await fetchBytes(`/api/cards/${made.body.id}/audio`);
    expect(audio).toMatchObject({ status: 200, type: "audio/aac" });
    // Roughly the Sentence's length: 1024 samples per frame at 24 kHz.
    const seconds = (adtsFrames(audio.bytes) * 1024) / 24_000;
    expect(Math.abs(seconds * 1000 - (sentence.endMs! - sentence.startMs!))).toBeLessThan(200);

    // The same Target again opens that Card (AC-CARD-09).
    const again = await postJson<Card>("/cards", { sentenceId: sentence.id, start: word.index, end: word.index + word[0].length });
    expect(again).toMatchObject({ status: 200, body: { id: made.body.id } });

    const changed = await postJson(`/books/${id}/voice`, { voice: "uk_male" });
    expect(changed.status).toBe(202);
    const done = await waitForBook(id, (b: BookDetail) => b.voiceChange === null, GENERATE_MS);
    expect(done.voice).toBe("uk_male");

    expect(await fetchBytes(`/api/cards/${made.body.id}/audio`)).toEqual(audio);
  });
});
