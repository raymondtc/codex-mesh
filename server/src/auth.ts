import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "./db/database.js";
import { schema } from "./db/schema.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const baseURL = process.env.BETTER_AUTH_URL ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
const secret = process.env.BETTER_AUTH_SECRET ?? process.env.REMOTE_WEB_TOKEN ?? "codex-mesh-local-development-secret-change-me";

if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");

export const auth = betterAuth({
  appName: "Codex Mesh",
  baseURL,
  secret,
  database: drizzleAdapter(db as never, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? baseURL).split(",").map((value) => value.trim()).filter(Boolean),
  plugins: [admin({ adminRoles: ["admin"], defaultRole: "user" })],
});

export type AuthSession = typeof auth.$Infer.Session;
