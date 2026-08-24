ALTER TABLE "user" ADD COLUMN "default_permission" text DEFAULT 'workspace-write' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "default_model" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "default_reasoning_effort" text DEFAULT 'high' NOT NULL;