CREATE TYPE "public"."difficulty" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
ALTER TABLE "books" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "library_key" text;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "difficulty" "difficulty";--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "blurb" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "play_guide_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_library_key_unique" UNIQUE("library_key");--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_owner_matches_source" CHECK (("books"."source" = 'upload' and "books"."owner_id" is not null) or ("books"."source" = 'library' and "books"."owner_id" is null and "books"."library_key" is not null and "books"."difficulty" is not null));