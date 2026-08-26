CREATE TABLE "tenant_members" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "connection_mode" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "tunnel_public_key" text;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_members_tenant_user_idx" ON "tenant_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "tenant_members_user_idx" ON "tenant_members" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "tenants" ("name", "slug") SELECT COALESCE(NULLIF("name", ''), "email"), 'personal-' || regexp_replace(lower("id"), '[^a-z0-9-]', '-', 'g') FROM "user" ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "tenant_members" ("tenant_id", "user_id", "role") SELECT "tenants"."id", "user"."id", 'owner' FROM "user" JOIN "tenants" ON "tenants"."slug" = 'personal-' || regexp_replace(lower("user"."id"), '[^a-z0-9-]', '-', 'g') ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "machines" SET "tenant_id" = "tenant_members"."tenant_id" FROM "tenant_members" WHERE "tenant_members"."user_id" = "machines"."owner_user_id";--> statement-breakpoint
UPDATE "conversations" SET "tenant_id" = "tenant_members"."tenant_id" FROM "tenant_members" WHERE "tenant_members"."user_id" = "conversations"."owner_user_id";--> statement-breakpoint
UPDATE "audit_events" SET "tenant_id" = COALESCE((SELECT "tenant_id" FROM "machines" WHERE "machines"."id" = "audit_events"."machine_id"), (SELECT "tenant_id" FROM "tenant_members" WHERE "tenant_members"."user_id" = "audit_events"."user_id" LIMIT 1));--> statement-breakpoint
ALTER TABLE "machines" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
