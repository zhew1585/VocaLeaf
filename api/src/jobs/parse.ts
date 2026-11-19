// Storing a parse result and queueing the Book's audio generation (PRD 4.3.4 steps 3 and 4).
import { eq } from "drizzle-orm";
import type { z } from "@hono/zod-openapi";
import type { ParseResultSchema } from "../contract.js";
import { books, chapters, jobs, sentences } from "../db/schema.js";
import { finishBookIfDone, type Tx } from "./lifecycle.js";

type ParseOutput = Omit<z.output<typeof ParseResultSchema>, "attempt">;

/** Postgres caps bind parameters at 65535 per statement; 6 columns per sentence row. */
const SENTENCE_INSERT_BATCH = 5000;

/**
 * Saves the Chapters and Sentences of a parsed Book, moves it from parsing to generating and queues one
 * render_chapter job per narrated Chapter, in Chapter order. A narrated Chapter without Sentences has no
 * audio to generate, so it is generated at once.
 */
export async function storeParseResult(tx: Tx, bookId: string, result: ParseOutput) {
  const inserted = await tx
    .insert(chapters)
    .values(
      result.chapters.map((ch, index) => ({
        bookId,
        index,
        // PRD 4.2.5: a Chapter without a TOC title is named 第 N 章.
        title: ch.title?.trim() || `第 ${index + 1} 章`,
        skipped: ch.skipped,
        ...(ch.sentences.length === 0 && !ch.skipped ? { audioStatus: "generated" as const, durationMs: 0 } : {}),
      })),
    )
    .returning({ id: chapters.id, index: chapters.index });

  const rows = inserted.flatMap(({ id, index }) =>
    result.chapters[index]!.sentences.map((s, i) => ({ chapterId: id, index: i, ...s })),
  );
  for (let i = 0; i < rows.length; i += SENTENCE_INSERT_BATCH) {
    await tx.insert(sentences).values(rows.slice(i, i + SENTENCE_INSERT_BATCH));
  }

  await tx
    .update(books)
    .set({
      status: "generating",
      parserVersion: result.parserVersion,
      ...(result.title?.trim() ? { title: result.title.trim() } : {}),
      author: result.author?.trim() || null,
      coverType: result.cover?.contentType ?? null,
    })
    .where(eq(books.id, bookId));

  const toRender = inserted
    .sort((a, b) => a.index - b.index)
    .filter(({ index }) => !result.chapters[index]!.skipped && result.chapters[index]!.sentences.length > 0);
  if (toRender.length > 0) {
    await tx.insert(jobs).values(
      toRender.map((ch, i) => ({ bookId, type: "render_chapter" as const, chapterId: ch.id, position: i + 1 })),
    );
  }
  await finishBookIfDone(tx, bookId);
}
