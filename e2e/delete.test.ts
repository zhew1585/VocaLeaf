// End-to-end: deleting a Book on the running compose stack (#8, PRD 4.3.6), while the real worker parses or
// generates it. The user deletes through the web origin; the worker learns of it only through the API.
// Needs `npm run e2e:up` (5 s job lease).
import { afterEach, describe, expect, it } from "vitest";
import type { Book, UploadPolicy } from "../api/src/contract.js";
import { anonApi, api, compose, endOpenJobs, newUser, PRIDE_AND_PREJUDICE, sql, upload, waitForBook } from "./support.js";

/** How long the worker may take to notice: its next report after a segment, or its next heartbeat. */
const NOTICE_MS = 60_000;

afterEach(() => endOpenJobs());

/** Keys under the Book's prefix in the stack's bucket, listed from inside the worker container (it has boto3). */
function storedKeys(bookId: string): string[] {
  const script = [
    "import os, sys, boto3",
    "from botocore.config import Config",
    "e = os.environ",
    "c = boto3.client('s3', endpoint_url=e['S3_ENDPOINT'], region_name=e['S3_REGION'], aws_access_key_id=e['S3_ACCESS_KEY_ID'], aws_secret_access_key=e['S3_SECRET_ACCESS_KEY'], config=Config(s3={'addressing_style': 'path'}))",
    "r = c.list_objects_v2(Bucket=e['S3_BUCKET'], Prefix=sys.argv[1])",
    "print('\\n'.join(o['Key'] for o in r.get('Contents', [])))",
  ].join("\n");
  const out = compose("exec", "-T", "worker", "python", "-c", script, `books/${bookId}/`);
  return out.split("\n").filter(Boolean);
}

/** Rows anything in the database still holds for the Book. */
function rowsOf(bookId: string) {
  return sql(
    `select (select count(*) from books where id = '${bookId}'), ` +
      `(select count(*) from chapters where book_id = '${bookId}'), ` +
      `(select count(*) from jobs where book_id = '${bookId}'), ` +
      `(select count(*) from shelf_entries where book_id = '${bookId}')`,
  );
}

async function waitUntil(check: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function deleteBook(id: string) {
  return api(`/books/${id}`, { method: "DELETE" });
}

describe("deleting a Book", () => {
  it("while it is 生成中 and playable: everything goes, the worker drops the Chapter, and nothing is left in storage", async () => {
    const { body: created } = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    const id = created.id;
    // Long Chapters: the worker is mid-Chapter when the user deletes.
    const playable = await waitForBook(id, (b) => b.playable, 90_000);
    // The user listened a little: the Shelf entry holds where they are.
    const listened = await api(`/books/${id}/listening`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionMs: 1000 }),
    });
    expect(listened.status).toBe(204);
    expect(sql(`select sentence_id is not null from shelf_entries where book_id = '${id}'`)).toEqual(["t"]);
    // Standard Ebooks EPUBs carry a cover, which the worker stored while parsing.
    expect(playable.coverUrl).not.toBeNull();
    expect(storedKeys(id)).toContain(`books/${id}/cover`);
    expect(storedKeys(id).some((k) => k.endsWith(".ts"))).toBe(true);
    expect(storedKeys(id)).toContain(`books/${id}/source.epub`);
    const [running] = sql(`select id, attempt from jobs where book_id = '${id}' and status = 'running'`);
    expect(running).toBeDefined();
    const [jobId, attempt] = running!.split("|");

    expect((await deleteBook(id)).status).toBe(204);

    expect((await api(`/books/${id}`)).status).toBe(404);
    expect((await api(`/books/${id}/audio.m3u8`)).status).toBe(404);
    expect((await api<Book[]>("/books")).body.map((b) => b.id)).not.toContain(id);
    expect(rowsOf(id)).toEqual(["0|0|0|0"]);

    // The worker learns from a refused report or heartbeat and drops the job; whatever it wrote meanwhile goes too.
    const dropped = `job ${jobId} attempt ${attempt} was superseded; dropped`;
    await waitUntil(() => compose("logs", "worker").includes(dropped), NOTICE_MS, "worker to drop the job");
    expect(storedKeys(id)).toEqual([]);

    // Logged for operators (PRD 4.6.2).
    const [entry] = sql(`select action, result, target from audit_log where target like '${id}%'`);
    expect(entry).toBe(`book_delete|deleted|${id} 《Pride and Prejudice》`);
  });

  it("while it is 解析中: the original goes and the worker's parse result is refused", async () => {
    const { body: created } = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    const id = created.id;
    expect(created.status).toBe("parsing");

    expect((await deleteBook(id)).status).toBe(204);

    expect((await api(`/books/${id}`)).status).toBe(404);
    expect(rowsOf(id)).toEqual(["0|0|0|0"]);
    // Should parsing have just finished, the worker may still write a segment before its report is refused.
    await waitUntil(() => storedKeys(id).length === 0, NOTICE_MS, "the Book's objects to go");
  });

  it("needs the owner's session", async () => {
    const { body: created } = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    expect((await anonApi(`/books/${created.id}`, { method: "DELETE" })).status).toBe(401);
    expect((await api(`/books/${created.id}`)).status).toBe(200);
    expect((await deleteBook(created.id)).status).toBe(204);
  });

  it("AC-BOOK-08: with 20 uploaded Books, deleting one lets the user upload again", async () => {
    const user = await newUser("quota");
    // Not real EPUBs: each fails parsing at once, so the worker spends nothing on them.
    const tiny = new Uint8Array([80, 75, 3, 4]);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await user.upload(`book-${i}.epub`, tiny);
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }
    expect((await user.upload("one-more.epub", tiny)).body).toMatchObject({ error: { code: "upload_limit_reached" } });

    expect((await user.api(`/books/${ids[0]}`, { method: "DELETE" })).status).toBe(204);

    expect((await user.api<UploadPolicy>("/upload-policy")).body.uploadedBooks).toBe(19);
    expect((await user.upload("one-more.epub", tiny)).status).toBe(201);
    expect((await user.api<Book[]>("/books")).body).toHaveLength(20);
  });
});
