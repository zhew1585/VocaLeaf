CREATE TYPE "public"."audio_status" AS ENUM('pending', 'generating', 'generated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."book_status" AS ENUM('parsing', 'generating', 'ready', 'parse_failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('parse');--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"format" text DEFAULT 'epub' NOT NULL,
	"file_size" integer NOT NULL,
	"status" "book_status" DEFAULT 'parsing' NOT NULL,
	"parser_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"title" text NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"audio_status" "audio_status" DEFAULT 'pending' NOT NULL,
	CONSTRAINT "chapters_book_id_index_unique" UNIQUE("book_id","index")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sentences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"paragraph_index" integer NOT NULL,
	"text" text NOT NULL,
	"spoken_text" text NOT NULL,
	CONSTRAINT "sentences_chapter_id_index_unique" UNIQUE("chapter_id","index")
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentences" ADD CONSTRAINT "sentences_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;