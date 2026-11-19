// Database schema. The API is the only component that reads or writes it (ADR 0002).
// Field names follow PRD 4.2 and 4.3.1. Fields that only later tickets read or write are added by those tickets;
// nothing reads a Skipped reason (PRD 4.2.5 skip_reason) yet.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AUDIO_STATUSES,
  BOOK_SOURCES,
  BOOK_STATUSES,
  DEFAULT_VOICE,
  DIFFICULTIES,
  MARK_STATUSES,
  VOICES,
  type ChatMessage,
  type WordTiming,
} from "../contract.js";

export const bookStatus = pgEnum("book_status", BOOK_STATUSES);
export const audioStatus = pgEnum("audio_status", AUDIO_STATUSES);
export const voice = pgEnum("voice", VOICES);
export const difficulty = pgEnum("difficulty", DIFFICULTIES);
// render_voice_change generates a Chapter's audio in the Voice a Book is changing to (PRD 4.2.4, 4.3.4), next
// to the audio that plays meanwhile.
export const jobType = pgEnum("job_type", ["parse", "render_chapter", "render_voice_change"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);
export const markStatus = pgEnum("mark_status", MARK_STATUSES);

/** Invited emails (PRD 4.1.1): only these may ask for a login code. Managed by scripts/allowlist.ts. */
export const allowlist = pgTable("allowlist", {
  // Always stored trimmed and lower-cased, as EmailSchema (contract.ts) reads it.
  email: text("email").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** An account, created on its first successful login (PRD 4.1.1). */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // The UPLOAD_DECLARATION version (contract.ts) the user last confirmed; null before their first upload.
  uploadDeclarationVersion: text("upload_declaration_version"),
  // When the user closed the first-play guide (F2, AC-GUIDE-02); null until then, so it shows on their first play.
  playGuideSeenAt: timestamp("play_guide_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The one outstanding login code of an email; a new code replaces it. */
export const loginCodes = pgTable("login_codes", {
  email: text("email").primaryKey(),
  // SHA-256 of the six digits; the code itself is only ever in the email (and the development log).
  codeHash: text("code_hash").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Wrong guesses so far; the code is dropped once they reach the limit (auth/login.ts).
  failedAttempts: integer("failed_attempts").notNull().default(0),
});

/** A logged-in device. Lives until that device logs out (PRD 4.1.1); one user may have many. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // SHA-256 of the token in the session cookie, so a database leak does not leak live sessions.
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Audit log (PRD 4.6.2): operator, time, action, target and result of each audited operation. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  result: text("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const books = pgTable(
  "books",
  {
    id: uuid("id").primaryKey(),
    // upload: one user's own Book, never shared. library: a Library Book whose text and audio every user shares (PRD 4.2.2).
    source: text("source", { enum: BOOK_SOURCES }).notNull().default("upload"),
    // The uploader; null for a Library Book.
    ownerId: uuid("owner_id").references(() => users.id),
    title: text("title").notNull(),
    author: text("author"),
    format: text("format", { enum: ["epub"] }).notNull().default("epub"),
    fileSize: integer("file_size").notNull(),
    status: bookStatus("status").notNull().default("parsing"),
    // The Voice of the audio that plays (PRD 4.2.4), chosen at upload.
    voice: voice("voice").notNull().default(DEFAULT_VOICE),
    // The Voice the Book is changing to (jobs/voice-change.ts): being generated, or the change failed. Null otherwise.
    voiceChangeTo: voice("voice_change_to"),
    // The change to voiceChangeTo failed and the Book kept its Voice (PRD 4.3.5 #11); shown until the next change.
    voiceChangeFailed: boolean("voice_change_failed").notNull().default(false),
    parserVersion: text("parser_version"),
    // User-facing reason shown with parse_failed (PRD 4.3.5 #4 to #6, #10).
    failureReason: text("failure_reason"),
    // Content type of the cover image at coverKey(id) (storage.ts); null when the EPUB has none.
    coverType: text("cover_type"),
    // Library Books only (PRD 4.2.2): the Standard Ebooks identifier it was ingested from (library/book-list.ts),
    // its difficulty group and the one-line blurb the 书库 shows.
    libraryKey: text("library_key").unique(),
    difficulty: difficulty("difficulty"),
    blurb: text("blurb"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // An uploaded Book always has its uploader; a Library Book belongs to no one and always has its book list entry.
  (t) => [
    check(
      "books_owner_matches_source",
      sql`(${t.source} = 'upload' and ${t.ownerId} is not null) or (${t.source} = 'library' and ${t.ownerId} is null and ${t.libraryKey} is not null and ${t.difficulty} is not null)`,
    ),
  ],
);

export const chapters = pgTable(
  "chapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    title: text("title").notNull(),
    skipped: boolean("skipped").notNull().default(false),
    // The user turned the Chapter's narration on (PRD 4.2.5 用户调整) after generation had gone past it. Its audio
    // is then generated out of Chapter order, behind where playback may already be, so the timeline leaves it out
    // until it is generated (books/timeline.ts). Stays set once the Chapter is generated; that no longer matters then.
    narratedByUser: boolean("narrated_by_user").notNull().default(false),
    audioStatus: audioStatus("audio_status").notNull().default("pending"),
    // Sum of the Chapter's segment durations, set when it is generated.
    durationMs: integer("duration_ms"),
  },
  (t) => [unique().on(t.bookId, t.index)],
);

export const sentences = pgTable(
  "sentences",
  {
    // Stable for the Book's lifetime: a Book is parsed once and never re-split (PRD 4.2.6).
    id: uuid("id").primaryKey().defaultRandom(),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    paragraphIndex: integer("paragraph_index").notNull(),
    text: text("text").notNull(),
    spokenText: text("spoken_text").notNull(),
    // Milliseconds from the start of the Chapter's audio, so they stay valid whichever Chapters are Skipped.
    // The API turns them into positions in the Book's continuous audio (books/timeline.ts).
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),
    // Relative to this Sentence's own start, so they still fit a copy of the Sentence's audio (a Card).
    wordTimings: jsonb("word_timings").$type<WordTiming[]>(),
  },
  (t) => [unique().on(t.chapterId, t.index)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    type: jobType("type").notNull(),
    // The Chapter a render job generates.
    chapterId: uuid("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    // Place of the job in its Book's pipeline: 0 = parse, n = the nth narrated Chapter. Claims take the lowest
    // first, so a newly uploaded Book's first Chapter is never stuck behind another Book's later Chapters.
    position: integer("position").notNull().default(0),
    // The Voice a render job generates (PRD 4.3.1): set when a render_chapter job is claimed (the Book's Voice
    // then), and when a render_voice_change job is queued (the Voice changed to). Null for parse jobs.
    voice: voice("voice"),
    status: jobStatus("status").notNull().default("queued"),
    // Incremented on every claim, and the fencing token callbacks must echo (see jobs/routes.ts).
    attempt: integer("attempt").notNull().default(0),
    // While running: when the claiming worker's lease ends and the job may be claimed again.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // When the current claim started. With updatedAt of a succeeded job, how long its last claim took:
    // the pace that estimates how long a waiting Chapter still waits (books/wait.ts).
    startedAt: timestamp("started_at", { withTimezone: true }),
    // Why the last attempt failed. Kept when the job is queued again for another attempt.
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A render job always names its Chapter; a parse job never does. Compared as text because the migration that
  // adds an enum value cannot use it in the same transaction.
  (t) => [check("jobs_chapter_matches_type", sql`(${t.type}::text <> 'parse') = (${t.chapterId} is not null)`)],
);

/**
 * HLS segments of a Chapter's audio, about 10 seconds each (PRD 4.7.2), as the worker reported them. Only the
 * segments in the Book's Voice play; while the Voice changes the new Voice's segments wait here unplayed, and
 * after the change the old Voice's stay (servable, for a player still holding them) until the next change.
 */
export const audioSegments = pgTable(
  "audio_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    voice: voice("voice").notNull(),
    index: integer("index").notNull(),
    key: text("key").notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [unique().on(t.chapterId, t.voice, t.index)],
);

/**
 * Sentence timings in the Voice a Book is changing to, kept aside while the old Voice's timings (on sentences)
 * still play; they replace those when the change completes (jobs/voice-change.ts).
 */
export const stagedSentenceTimings = pgTable("staged_sentence_timings", {
  sentenceId: uuid("sentence_id")
    .primaryKey()
    .references(() => sentences.id, { onDelete: "cascade" }),
  voice: voice("voice").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  wordTimings: jsonb("word_timings").$type<WordTiming[]>().notNull(),
});

/**
 * A user's Shelf (PRD 4.2.3): the Books they uploaded and the Library Books they added, with where they
 * are in each. Listening progress is per user even for a shared Book, so it lives here, not on the Book.
 */
export const shelfEntries = pgTable(
  "shelf_entries",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    // When the user last played the Book; the Shelf lists recently listened Books first.
    lastListenedAt: timestamp("last_listened_at", { withTimezone: true }),
    // The Sentence playback resumes at (PRD 4.4.1 进度同步).
    sentenceId: uuid("sentence_id").references(() => sentences.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] })],
);

/**
 * A Sentence one user flagged while listening (PRD 4.4.2): one Mark per user and Sentence, whatever happens to it.
 * Pending Marks make up the user's Gleanings (PRD 4.4.4). Goes with its Book (PRD 4.3.6).
 */
export const marks = pgTable(
  "marks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sentenceId: uuid("sentence_id")
      .notNull()
      .references(() => sentences.id, { onDelete: "cascade" }),
    // Redundant with the Sentence's Chapter, for listing a Book's Marks without joins (PRD 4.4.2).
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    status: markStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // When the status last changed; Gleanings list pending Marks by it, newest first.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sentenceId] }), index("marks_user_status_idx").on(t.userId, t.status)],
);

/**
 * A user's Explanation of one Sentence with their follow-up questions (PRD 4.5.1): private to the user, even for a
 * shared Book. A row exists once the user asked the AI anything about the Sentence.
 */
export const explanations = pgTable(
  "explanations",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sentenceId: uuid("sentence_id")
      .notNull()
      .references(() => sentences.id, { onDelete: "cascade" }),
    // Markdown; null while the user only asked questions. Regenerating replaces it and keeps the messages.
    content: text("content"),
    // Follow-up questions and answers in order; the AI sees them, with the Explanation, on the next question.
    messages: jsonb("messages").$type<ChatMessage[]>().notNull().default([]),
    // The model that wrote the latest answer.
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sentenceId] })],
);

/** AI calls a user made on one day in Asia/Shanghai, against the daily limit (PRD 4.7.2, DAILY_AI_CALLS). */
export const aiUsage = pgTable(
  "ai_usage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);
