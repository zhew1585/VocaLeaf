ALTER TABLE "books" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;