// Database schema. The API is the only component that reads or writes it (ADR 0002).
// Field names follow PRD 4.2 and 4.3.1. Fields that only later tickets read or write
// (cover, Skipped reason) are added by those tickets.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { AUDIO_STATUSES, BOOK_STATUSES, DEFAULT_VOICE, VOICES, type WordTiming } from "../contract.js";

export const bookStatus = pgEnum("book_status", BOOK_STATUSES);
export const audioStatus = pgEnum("audio_status", AUDIO_STATUSES);
export const voice = pgEnum("voice", VOICES);
export const jobType = pgEnum("job_type", ["parse", "render_chapter"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);

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

export const books = pgTable("books", {
  id: uuid("id").primaryKey(),
  source: text("source", { enum: ["upload"] }).notNull().default("upload"),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  author: text("author"),
  format: text("format", { enum: ["epub"] }).notNull().default("epub"),
  fileSize: integer("file_size").notNull(),
  status: bookStatus("status").notNull().default("parsing"),
  // Fixed to the default until Voice selection (#19).
  voice: voice("voice").notNull().default(DEFAULT_VOICE),
  parserVersion: text("parser_version"),
  // User-facing reason shown with parse_failed; the full set of reasons (PRD 4.3.5) comes with #3.
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    // The Chapter a render_chapter job generates.
    chapterId: uuid("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    // Place of the job in its Book's pipeline: 0 = parse, n = the nth narrated Chapter. Claims take the lowest
    // first, so a newly uploaded Book's first Chapter is never stuck behind another Book's later Chapters.
    position: integer("position").notNull().default(0),
    status: jobStatus("status").notNull().default("queued"),
    // Incremented on every claim, and the fencing token callbacks must echo (see jobs/routes.ts).
    attempt: integer("attempt").notNull().default(0),
    // While running: when the claiming worker's lease ends and the job may be claimed again.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A render_chapter job always names its Chapter; a parse job never does. Compared as text because the
  // migration that adds the enum value cannot use it in the same transaction.
  (t) => [check("jobs_chapter_matches_type", sql`(${t.type}::text = 'render_chapter') = (${t.chapterId} is not null)`)],
);

/** HLS segments of a Chapter's audio, about 10 seconds each (PRD 4.7.2), as the worker reported them. */
export const audioSegments = pgTable(
  "audio_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    key: text("key").notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [unique().on(t.chapterId, t.index)],
);
