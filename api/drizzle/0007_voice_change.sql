ALTER TYPE "public"."job_type" ADD VALUE 'render_voice_change';--> statement-breakpoint
CREATE TABLE "staged_sentence_timings" (
	"sentence_id" uuid PRIMARY KEY NOT NULL,
	"voice" "voice" NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"word_timings" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audio_segments" DROP CONSTRAINT "audio_segments_chapter_id_index_unique";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_chapter_matches_type";--> statement-breakpoint
ALTER TABLE "audio_segments" ADD COLUMN "voice" "voice";--> statement-breakpoint
-- Every segment so far is in its Book's Voice, which could not change before this migration.
UPDATE "audio_segments" SET "voice" = "books"."voice" FROM "chapters", "books" WHERE "chapters"."id" = "audio_segments"."chapter_id" AND "books"."id" = "chapters"."book_id";--> statement-breakpoint
ALTER TABLE "audio_segments" ALTER COLUMN "voice" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "voice_change_to" "voice";--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "voice_change_failed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "voice" "voice";--> statement-breakpoint
-- Render jobs so far render their Book's Voice, which could not change before this migration.
UPDATE "jobs" SET "voice" = "books"."voice" FROM "books" WHERE "books"."id" = "jobs"."book_id" AND "jobs"."type"::text = 'render_chapter';--> statement-breakpoint
ALTER TABLE "staged_sentence_timings" ADD CONSTRAINT "staged_sentence_timings_sentence_id_sentences_id_fk" FOREIGN KEY ("sentence_id") REFERENCES "public"."sentences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_chapter_id_voice_index_unique" UNIQUE("chapter_id","voice","index");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_chapter_matches_type" CHECK (("jobs"."type"::text <> 'parse') = ("jobs"."chapter_id" is not null));