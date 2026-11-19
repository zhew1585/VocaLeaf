CREATE TYPE "public"."target_kind" AS ENUM('word', 'phrase', 'sentence');--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sentence_id" uuid,
	"target_text" text NOT NULL,
	"target_kind" "target_kind" NOT NULL,
	"target_start" integer NOT NULL,
	"target_end" integer NOT NULL,
	"sentence_text" text NOT NULL,
	"context_before" text,
	"context_after" text,
	"audio_key" text,
	"book_title" text NOT NULL,
	"back" jsonb,
	"due" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_user_sentence_target" UNIQUE("user_id","sentence_id","target_start","target_end")
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_sentence_id_sentences_id_fk" FOREIGN KEY ("sentence_id") REFERENCES "public"."sentences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_sentence_idx" ON "cards" USING btree ("sentence_id");