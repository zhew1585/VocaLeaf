// HTTP contract shared by the API, the web client (type-only imports) and the OpenAPI document.
// The Python worker follows the /internal schemas below; keep worker/src/vocaleaf_worker/api_client.py in sync.
import { z } from "@hono/zod-openapi";

export const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

/** Main Book status, PRD 4.3.3. Also the database enum (db/schema.ts). */
export const BOOK_STATUSES = ["parsing", "generating", "ready", "parse_failed"] as const;
export const BookStatusSchema = z.enum(BOOK_STATUSES);

/** Chapter audio_status, PRD 4.3.3. Also the database enum (db/schema.ts). */
export const AUDIO_STATUSES = ["pending", "generating", "generated", "failed"] as const;
export const AudioStatusSchema = z.enum(AUDIO_STATUSES);

export const BookSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    author: z.string().nullable(),
    status: BookStatusSchema,
    createdAt: z.iso.datetime(),
  })
  .openapi("Book");

export const ChapterSummarySchema = z
  .object({
    id: z.uuid(),
    index: z.int(),
    title: z.string(),
    skipped: z.boolean(),
    audioStatus: AudioStatusSchema,
    sentenceCount: z.int(),
  })
  .openapi("ChapterSummary");

export const BookDetailSchema = BookSchema.extend({
  chapters: z.array(ChapterSummarySchema),
}).openapi("BookDetail");

export const SentenceSchema = z
  .object({
    id: z.uuid(),
    index: z.int(),
    paragraphIndex: z.int(),
    text: z.string(),
    spokenText: z.string(),
  })
  .openapi("Sentence");

export const UploadBookSchema = z.object({
  file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
});

// ---- Worker protocol (/internal), bearer-token protected ----

export const ClaimedJobSchema = z
  .object({
    id: z.uuid(),
    type: z.literal("parse"),
    bookId: z.uuid(),
    /** Object key of the original EPUB in the bucket. */
    sourceKey: z.string(),
  })
  .openapi("ClaimedJob");

export const ParsedSentenceSchema = z.object({
  paragraphIndex: z.int().min(0),
  text: z.string().min(1),
  spokenText: z.string().min(1),
});

export const ParsedChapterSchema = z.object({
  /** Title from the table of contents; null when missing (the API then names it 第 N 章). */
  title: z.string().nullable(),
  sentences: z.array(ParsedSentenceSchema),
});

export const ParseResultSchema = z
  .object({
    parserVersion: z.string().min(1),
    title: z.string().nullable(),
    author: z.string().nullable(),
    chapters: z.array(ParsedChapterSchema).min(1),
  })
  .openapi("ParseResult");

export const JobFailureSchema = z.object({ error: z.string() }).openapi("JobFailure");

export type BookStatus = z.infer<typeof BookStatusSchema>;
export type AudioStatus = z.infer<typeof AudioStatusSchema>;
export type Book = z.infer<typeof BookSchema>;
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;
export type BookDetail = z.infer<typeof BookDetailSchema>;
export type Sentence = z.infer<typeof SentenceSchema>;
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type ParseResult = z.infer<typeof ParseResultSchema>;
export type ApiError = z.infer<typeof ErrorSchema>;
