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

/**
 * Voice a Book is narrated with, PRD 4.2.4: US/UK, female/male. Also the database enum.
 * Which TTS voice each one maps to is the worker's technical config (PRD 4.7.2).
 */
export const VOICES = ["us_female", "us_male", "uk_female", "uk_male"] as const;
export const VoiceSchema = z.enum(VOICES);
export const DEFAULT_VOICE = "us_female" satisfies (typeof VOICES)[number];

export const BookSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    author: z.string().nullable(),
    status: BookStatusSchema,
    /**
     * Whether the Book's audio can be played (PRD 4.3.3 invariant 3): the playlist has at least one segment.
     * While generating this tells 生成中·未可播 (false) from 生成中·可播 (true).
     */
    playable: z.boolean(),
    /** Why parsing failed, shown with parse_failed. Null otherwise, and for most failures until #3 adds reasons. */
    failureReason: z.string().nullable(),
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
    /** Length of the Chapter's audio once generated, null before. */
    durationMs: z.int().nullable(),
  })
  .openapi("ChapterSummary");

export const BookDetailSchema = BookSchema.extend({
  chapters: z.array(ChapterSummarySchema),
  /**
   * Length of the Book's whole audio. Exact once ready; while generating, the Chapters not generated yet are
   * estimated from how long the generated ones take per character. Null until a Chapter is generated.
   */
  durationMs: z.int().nullable(),
}).openapi("BookDetail");

/** When one word is spoken, in milliseconds from the start of its own Sentence's audio. */
export const WordTimingSchema = z
  .object({ word: z.string(), startMs: z.int().min(0), endMs: z.int().min(0) })
  .openapi("WordTiming");

export const SentenceSchema = z
  .object({
    id: z.uuid(),
    index: z.int(),
    paragraphIndex: z.int(),
    text: z.string(),
    spokenText: z.string(),
    /**
     * Where the Sentence is in the Book's continuous audio (PRD 4.2.6), in milliseconds from the start of the
     * playlist. Null until its Chapter is generated and every narrated Chapter before it is in the playlist.
     */
    startMs: z.int().nullable(),
    endMs: z.int().nullable(),
    /** Word-level timing; stored only, nothing reads it yet (PRD 4.2.6). */
    wordTimings: z.array(WordTimingSchema).nullable(),
  })
  .openapi("Sentence");

export const UploadBookSchema = z.object({
  file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
});

// ---- Worker protocol (/internal), bearer-token protected ----

/**
 * Which claim of a job this is. Handed out with ClaimedJob and echoed on every report;
 * a report from a claim that has since been superseded is refused.
 */
const AttemptSchema = z.int().min(1);

const claimedJobBase = {
  id: z.uuid(),
  bookId: z.uuid(),
  attempt: AttemptSchema,
  /** How long this claim holds the job; the worker sends a heartbeat well within it to keep the job. */
  leaseMs: z.int().positive(),
};

export const ClaimedParseJobSchema = z
  .object({
    ...claimedJobBase,
    type: z.literal("parse"),
    /** Object key of the original EPUB in the bucket. */
    sourceKey: z.string(),
  })
  .openapi("ClaimedParseJob");

export const ClaimedRenderJobSchema = z
  .object({
    ...claimedJobBase,
    type: z.literal("render_chapter"),
    chapterId: z.uuid(),
    voice: VoiceSchema,
    /** Every segment of this claim is written under this object key prefix. */
    audioPrefix: z.string(),
    /** The Chapter's Sentences in reading order, with their paragraph (PRD 4.2.6) for pacing the narration. */
    sentences: z.array(z.object({ id: z.uuid(), spokenText: z.string(), paragraphIndex: z.int().min(0) })),
  })
  .openapi("ClaimedRenderJob");

export const ClaimedJobSchema = z
  .discriminatedUnion("type", [ClaimedParseJobSchema, ClaimedRenderJobSchema])
  .openapi("ClaimedJob");

export const ParsedSentenceSchema = z.object({
  paragraphIndex: z.int().min(0),
  text: z.string().min(1),
  spokenText: z.string().min(1),
});

export const ParsedChapterSchema = z.object({
  /** Title from the table of contents; null when missing (the API then names it 第 N 章). */
  title: z.string().nullable(),
  /** Kept in the Book but not narrated (PRD 4.2.5). The worker detects it from #3 on; absent means narrated. */
  skipped: z.boolean().default(false),
  sentences: z.array(ParsedSentenceSchema),
});

export const ParseResultSchema = z
  .object({
    attempt: AttemptSchema,
    parserVersion: z.string().min(1),
    title: z.string().nullable(),
    author: z.string().nullable(),
    chapters: z.array(ParsedChapterSchema).min(1),
  })
  .openapi("ParseResult");

export const HeartbeatSchema = z.object({ attempt: AttemptSchema }).openapi("Heartbeat");

/** One HLS segment the worker wrote: about 10 seconds of AAC in MPEG-TS (PRD 4.7.2). */
export const RenderedSegmentSchema = z.object({
  /** Position within the Chapter, from 0. */
  index: z.int().min(0),
  /** Object key; must be under the claim's audioPrefix. */
  key: z.string().min(1),
  durationMs: z.int().positive(),
});

/** Where one Sentence landed in its Chapter's audio. */
export const RenderedSentenceSchema = z.object({
  id: z.uuid(),
  /** Milliseconds from the start of the Chapter's audio. */
  startMs: z.int().min(0),
  endMs: z.int().min(0),
  wordTimings: z.array(WordTimingSchema),
});

/**
 * Segments and Sentences rendered since the previous report of this claim. Sent as render-progress while the
 * Chapter is being generated (so the Book is playable after its first segment) and as render-result at the end.
 */
export const RenderReportSchema = z
  .object({
    attempt: AttemptSchema,
    segments: z.array(RenderedSegmentSchema),
    sentences: z.array(RenderedSentenceSchema),
  })
  .openapi("RenderReport");

export const JobFailureSchema = z.object({ attempt: AttemptSchema, error: z.string() }).openapi("JobFailure");

export type BookStatus = z.infer<typeof BookStatusSchema>;
export type AudioStatus = z.infer<typeof AudioStatusSchema>;
export type Book = z.infer<typeof BookSchema>;
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;
export type BookDetail = z.infer<typeof BookDetailSchema>;
export type Sentence = z.infer<typeof SentenceSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type WordTiming = z.infer<typeof WordTimingSchema>;
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type ClaimedParseJob = z.infer<typeof ClaimedParseJobSchema>;
export type ClaimedRenderJob = z.infer<typeof ClaimedRenderJobSchema>;
export type RenderReport = z.infer<typeof RenderReportSchema>;
export type ParseResult = z.input<typeof ParseResultSchema>;
export type ApiError = z.infer<typeof ErrorSchema>;
