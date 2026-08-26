ALTER TABLE "machines" ADD COLUMN "ssh_host" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "ssh_port" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "ssh_username" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "ssh_private_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "ssh_public_key" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "ssh_host_key_sha256" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "ssh_codex_command" text;