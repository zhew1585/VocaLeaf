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

// ---- Login (PRD 4.1.1, F1) ----

/** Login code length, and how long after one code another may be sent (AC-AUTH-04). */
export const LOGIN_CODE_LENGTH = 6;
export const LOGIN_CODE_RESEND_SECONDS = 60;

/** An email as typed; compared and stored trimmed and lower-cased. */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email());

export const RequestCodeSchema = z.object({ email: EmailSchema }).openapi("RequestCode");

export const LoginSchema = z
  .object({ email: EmailSchema, code: z.string().regex(new RegExp(`^\\d{${LOGIN_CODE_LENGTH}}$`)) })
  .openapi("Login");

export const CodeSentSchema = z
  .object({ /** When the client may offer to send another code. */ resendAfterSeconds: z.int().positive() })
  .openapi("CodeSent");

export const UserSchema = z.object({ id: z.uuid(), email: z.string() }).openapi("User");

// ---- Upload (PRD 4.1.2, 4.3.2, 4.7.2) ----

/** Single file size limit (PRD 4.7.2): 50MB. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Uploaded Books one user may hold at a time (PRD 4.7.2); deleting one frees its place. */
export const MAX_UPLOADED_BOOKS = 20;
/**
 * The upload rights declaration (PRD 4.1.2). A user confirms it before their first upload, and again after its
 * version changes; each confirmation goes to the audit log. Change the version whenever the text changes.
 */
export const UPLOAD_DECLARATION = {
  version: "1",
  text: "我确认拥有该文件的合法使用权，文件不含 DRM，仅供本人收听学习",
} as const;

/** What the upload dialog checks before sending a file, so a file it would refuse is not sent at all. */
export const UploadPolicySchema = z
  .object({
    maxFileBytes: z.int().positive(),
    maxBooks: z.int().positive(),
    /** Uploaded Books the user holds now. */
    uploadedBooks: z.int().min(0),
    declaration: z.object({
      version: z.string(),
      text: z.string(),
      /** Whether the user confirmed this version already; the dialog then does not ask again. */
      accepted: z.boolean(),
    }),
  })
  .openapi("UploadPolicy");

// ---- Books and the Shelf ----

/**
 * Cover image types the worker keeps (anything else gets the app's default cover). Keep in sync with
 * COVER_MEDIA_TYPES in worker/src/vocaleaf_worker/epub_parser.py.
 */
export const COVER_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/** Where the user is in a Book they listened to (PRD 4.2.3, 4.4.1 进度同步). */
export const ListeningSchema = z
  .object({
    /** The Sentence playback resumes at, from its start. */
    sentenceId: z.uuid(),
    /**
     * Title of the Chapter playback resumes in (【继续收听】: Chapter 1 · 34%): the Sentence's own, or the next narrated
     * one when the Sentence's Chapter was set Skipped since.
     */
    chapterTitle: z.string(),
    /**
     * How much of the Book was listened to, 0 to 1: its audio up to that Sentence out of the whole (as the 专注页
     * counts it), or its narrated text before that Sentence while the Sentence has no audio in the playlist.
     */
    share: z.number().min(0).max(1),
    /** Where that Sentence starts in the Book's audio, in milliseconds; null while its Chapter has no audio there. */
    startMs: z.int().min(0).nullable(),
    listenedAt: z.iso.datetime(),
  })
  .openapi("Listening");

/** Reported by the player: where playback is in the Book's audio. The API records the Sentence there. */
export const ListeningUpdateSchema = z.object({ positionMs: z.int().min(0) }).openapi("ListeningUpdate");

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
    /** Why parsing failed (PRD 4.3.5 #4 to #6, #10), shown with parse_failed. Null otherwise. */
    failureReason: z.string().nullable(),
    /** Generation progress shown while generating (PRD 4.3.3): 生成中 {generated}/{narrated}. */
    progress: z
      .object({
        /** Narrated Chapters generated so far. */
        generated: z.int().min(0),
        /** Chapters that are not Skipped. 0 while parsing. */
        narrated: z.int().min(0),
      })
      .openapi("BookProgress"),
    /** The cover image, or null when the EPUB has none (the app draws a default cover). */
    coverUrl: z.string().nullable(),
    /** The user's place in the Book, or null when they never listened to it. */
    listening: ListeningSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Book");

/**
 * Where a Book comes from (CONTEXT.md): uploaded by its user, or (with #12) the Library. Also the database column.
 * Only an uploaded Book's Chapters can be set Skipped or narrated (PRD 4.2.5, F5).
 */
export const BOOK_SOURCES = ["upload"] as const;
export const BookSourceSchema = z.enum(BOOK_SOURCES);

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
    /**
     * Where the Chapter's audio starts in the Book's playlist, in milliseconds; playing from a Chapter seeks here.
     * Null while the playlist has none of its audio yet.
     */
    startMs: z.int().min(0).nullable(),
    /**
     * For a Chapter without audio in the playlist yet that is queued or generating: about how many seconds until
     * it plays (PRD 4.3.4, 【该章节生成中，预计约 N 秒】). Null otherwise.
     */
    waitSeconds: z.int().positive().nullable(),
  })
  .openapi("ChapterSummary");

export const BookDetailSchema = BookSchema.extend({
  source: BookSourceSchema,
  chapters: z.array(ChapterSummarySchema),
  /**
   * Length of the Book's whole audio. Exact once ready; while generating, the Chapters not generated yet are
   * estimated from how long the generated ones take per character. Null until a Chapter is generated.
   */
  durationMs: z.int().nullable(),
}).openapi("BookDetail");

/** Sets a Chapter Skipped (true) or narrated (false), PRD 4.2.5 用户调整. */
export const ChapterSkippedUpdateSchema = z.object({ skipped: z.boolean() }).openapi("ChapterSkippedUpdate");

/**
 * Where a Book's Sentences and narrated Chapters sit in its continuous audio, in milliseconds from the playlist's
 * start: what the player steers by (重听, 下一句, 本章结束, PRD 4.4.1 and 4.4.3). Holds only what the playlist holds.
 */
export const BookTimelineSchema = z
  .object({
    /** Start of every Sentence in the playlist, ascending. */
    sentenceStartsMs: z.array(z.int().min(0)),
    /** The narrated Chapters in the playlist, in order; a Chapter still generating has no end yet. */
    chapters: z.array(z.object({ id: z.uuid(), startMs: z.int().min(0), endMs: z.int().min(0).nullable() })),
    /** No more audio will be appended at the end (the playlist has ENDLIST). */
    complete: z.boolean(),
    /**
     * Every narrated Chapter is generated or failed, so the playlist changes no more unless the user changes the
     * Book. While false, a Chapter may still come in, at the end or (generated out of order) before it.
     */
    settled: z.boolean(),
  })
  .openapi("BookTimeline");

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
  /** The UPLOAD_DECLARATION version the user just confirmed; needed while they have not confirmed it before. */
  declarationVersion: z.string().optional(),
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
    /** Where the worker writes the Book's cover image, when the EPUB has one. */
    coverKey: z.string(),
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
  /** Kept in the Book but not narrated (PRD 4.2.5), as the worker detected it; absent means narrated. */
  skipped: z.boolean().default(false),
  sentences: z.array(ParsedSentenceSchema),
});

export const ParseResultSchema = z
  .object({
    attempt: AttemptSchema,
    parserVersion: z.string().min(1),
    title: z.string().nullable(),
    author: z.string().nullable(),
    /** The cover the worker wrote to the claim's coverKey, or null when the EPUB has none it could use. */
    cover: z.object({ contentType: z.enum(COVER_TYPES) }).nullable().default(null),
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

/**
 * Why a Book cannot be parsed (PRD 4.3.5): DRM (#4), a broken file (#5), or no text to narrate (#6).
 * The API turns it into the message the user sees.
 */
export const PARSE_FAILURE_REASONS = ["drm", "unreadable", "no_text"] as const;

export const JobFailureSchema = z
  .object({
    attempt: AttemptSchema,
    /** For the job log only. */
    error: z.string(),
    /** Sent when a parse fails because of the file; a failure without one is retried like any other. */
    reason: z.enum(PARSE_FAILURE_REASONS).optional(),
  })
  .openapi("JobFailure");

export type BookStatus = z.infer<typeof BookStatusSchema>;
export type AudioStatus = z.infer<typeof AudioStatusSchema>;
export type Book = z.infer<typeof BookSchema>;
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;
export type BookDetail = z.infer<typeof BookDetailSchema>;
export type BookTimeline = z.infer<typeof BookTimelineSchema>;
export type Sentence = z.infer<typeof SentenceSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type WordTiming = z.infer<typeof WordTimingSchema>;
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type ClaimedParseJob = z.infer<typeof ClaimedParseJobSchema>;
export type ClaimedRenderJob = z.infer<typeof ClaimedRenderJobSchema>;
export type RenderReport = z.infer<typeof RenderReportSchema>;
export type ParseFailureReason = (typeof PARSE_FAILURE_REASONS)[number];
export type ParseResult = z.input<typeof ParseResultSchema>;
export type User = z.infer<typeof UserSchema>;
export type UploadPolicy = z.infer<typeof UploadPolicySchema>;
export type Listening = z.infer<typeof ListeningSchema>;
export type CodeSent = z.infer<typeof CodeSentSchema>;
export type ApiError = z.infer<typeof ErrorSchema>;
