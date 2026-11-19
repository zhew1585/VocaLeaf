CREATE TYPE "public"."mark_status" AS ENUM('pending', 'processed', 'dismissed');--> statement-breakpoint
CREATE TABLE "marks" (
	"user_id" uuid NOT NULL,
	"sentence_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"status" "mark_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marks_user_id_sentence_id_pk" PRIMARY KEY("user_id","sentence_id")
);
--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_sentence_id_sentences_id_fk" FOREIGN KEY ("sentence_id") REFERENCES "public"."sentences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marks_user_status_idx" ON "marks" USING btree ("user_id","status");