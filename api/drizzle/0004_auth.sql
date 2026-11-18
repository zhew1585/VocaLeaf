CREATE TABLE "allowlist" (
	"email" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_codes" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Books uploaded before login existed belong to the temporary dev identity (#1). Give each such owner an account,
-- dev@vocaleaf.local for the dev identity, so the foreign key holds; allowlisting that email reaches those Books.
INSERT INTO "users" ("id", "email")
SELECT DISTINCT "owner_id", CASE WHEN "owner_id" = '00000000-0000-4000-8000-000000000001' THEN 'dev@vocaleaf.local' ELSE 'owner-' || "owner_id" || '@vocaleaf.local' END
FROM "books" ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;