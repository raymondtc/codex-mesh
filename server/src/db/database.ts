import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
const dataRoot = resolve(process.env.CODEX_MESH_DATA_DIR ?? join(homedir(), ".codex-mesh"));
const pglitePath = resolve(process.env.PGLITE_DIR ?? join(dataRoot, "database"));

let pool: Pool | undefined;
let pglite: PGlite | undefined;

if (databaseUrl) {
  pool = new Pool({ connectionString: databaseUrl });
} else {
  await mkdir(pglitePath, { recursive: true, mode: 0o700 });
  pglite = new PGlite(pglitePath);
  await pglite.waitReady;
}

export const databaseKind = databaseUrl ? "postgres" : "pglite";
export const db = databaseUrl
  ? drizzlePg({ client: pool as Pool, schema })
  : drizzlePglite({ client: pglite as PGlite, schema });

export async function migrateDatabase(): Promise<void> {
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
  if (databaseUrl) {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) await pool.end();
  if (pglite) await pglite.close();
}
