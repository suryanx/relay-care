import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { schema } from "./schema.js";

/** Driver-agnostic Drizzle handle. Application code only ever sees this type. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  kind: "postgres" | "pglite";
  close: () => Promise<void>;
}

export type DatabaseOptions =
  | { kind: "postgres"; url: string }
  /** dataDir undefined → in-memory (tests). PGlite is for development and tests only. */
  | { kind: "pglite"; dataDir?: string };

/**
 * pg.Pool emits "error" when an idle client's connection drops (e.g. the database closes it).
 * Without a listener Node treats that as an uncaught exception and exits. The pool already
 * discards the broken client, so we only log a minimal, non-sensitive line: the error code,
 * never the message, connection string, host or credentials.
 */
export function attachPoolErrorHandler(pool: Pick<pg.Pool, "on">, log: (line: string) => void = (l) => console.error(l)): void {
  pool.on("error", (err: Error & { code?: string }) => {
    log(`[db] idle connection error (${err.code ?? err.name ?? "unknown"}); connection discarded, pool continues.`);
  });
}

const migrationsFolder = path.resolve(process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle"));

/** Opens the database and applies the shared SQL migrations. */
export async function openDatabase(options: DatabaseOptions): Promise<DatabaseHandle> {
  if (options.kind === "postgres") {
    const pool = new pg.Pool({ connectionString: options.url, max: 5 });
    attachPoolErrorHandler(pool);
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder });
    return { db: db as unknown as Database, kind: "postgres", close: () => pool.end() };
  }

  // PGlite does not create parent directories for file-backed databases.
  if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
  const client = new PGlite(options.dataDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as Database, kind: "pglite", close: () => client.close() };
}
