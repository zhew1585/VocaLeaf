CREATE TABLE "shelf_entries" (
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_listened_at" timestamp with time zone,
	"sentence_id" uuid,
	CONSTRAINT "shelf_entries_user_id_book_id_pk" PRIMARY KEY("user_id","book_id")
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "cover_type" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "upload_declaration_version" text;--> statement-breakpoint
ALTER TABLE "shelf_entries" ADD CONSTRAINT "shelf_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_entries" ADD CONSTRAINT "shelf_entries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_entries" ADD CONSTRAINT "shelf_entries_sentence_id_sentences_id_fk" FOREIGN KEY ("sentence_id") REFERENCES "public"."sentences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Every Book uploaded so far is on its uploader's Shelf, added when it was uploaded.
INSERT INTO "shelf_entries" ("user_id", "book_id", "added_at") SELECT "owner_id", "id", "created_at" FROM "books";
