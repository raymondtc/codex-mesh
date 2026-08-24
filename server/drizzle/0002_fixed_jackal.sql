ALTER TABLE "conversations" ADD COLUMN "kind" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "parent_remote_thread_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "main_root" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "branch" text;
