// Database schema. The API is the only component that reads or writes it (ADR 0002).
// Field names follow PRD 4.2 and 4.3.1. Fields that only later tickets read or write
// (cover, voice, Skipped reason, audio timing) are added by those tickets.
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { AUDIO_STATUSES, BOOK_STATUSES } from "../contract.js";

export const bookStatus = pgEnum("book_status", BOOK_STATUSES);
export const audioStatus = pgEnum("audio_status", AUDIO_STATUSES);
export const jobType = pgEnum("job_type", ["parse"]);
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
  parserVersion: text("parser_version"),
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
  },
  (t) => [unique().on(t.chapterId, t.index)],
);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  type: jobType("type").notNull(),
  status: jobStatus("status").notNull().default("queued"),
  // Incremented on every claim. No lease timeout yet: a job whose worker dies stays running;
  // timeouts and automatic retries (PRD 4.3.5 #8, #10) arrive with #5.
  attempt: integer("attempt").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
