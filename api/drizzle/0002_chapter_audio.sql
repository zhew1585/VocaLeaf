CREATE TYPE "public"."voice" AS ENUM('us_female', 'us_male', 'uk_female', 'uk_male');--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'render_chapter';--> statement-breakpoint
CREATE TABLE "audio_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"key" text NOT NULL,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "audio_segments_chapter_id_index_unique" UNIQUE("chapter_id","index")
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "voice" "voice" DEFAULT 'us_female' NOT NULL;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "chapter_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sentences" ADD COLUMN "start_ms" integer;--> statement-breakpoint
ALTER TABLE "sentences" ADD COLUMN "end_ms" integer;--> statement-breakpoint
ALTER TABLE "sentences" ADD COLUMN "word_timings" jsonb;--> statement-breakpoint
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;