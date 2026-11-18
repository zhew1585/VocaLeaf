// Database schema. The API is the only component that reads or writes it (ADR 0002).
// Field names follow PRD 4.2 and 4.3.1. Fields that only later tickets read or write
// (cover, Skipped reason) are added by those tickets.
import {
  boolean,
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

export const books = pgTable("books", {
  id: uuid("id").primaryKey(),
  source: text("source", { enum: ["upload"] }).notNull().default("upload"),
  // No users table yet: login and accounts arrive with #6, which adds the foreign key.
  ownerId: uuid("owner_id").notNull(),
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

export const jobs = pgTable("jobs", {
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
});

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
