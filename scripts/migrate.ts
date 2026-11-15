/**
 * Applies the Drizzle SQL migrations explicitly (they also run, idempotently, on server boot).
 *   DATABASE_URL=... npm run db:migrate
 * Never prints the connection string.
 */
import { loadEnv } from "../src/server/config.js";
import { openDatabase } from "../src/server/db/client.js";
import { sql } from "drizzle-orm";

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error("[migrate] DATABASE_URL is not set. Refusing to touch the local PGlite database.");
  process.exit(1);
}
const handle = await openDatabase({ kind: "postgres", url: env.DATABASE_URL });
const result = (await handle.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)) as unknown as {
  rows: { table_name: string }[];
};
console.info(`[migrate] OK. Tables: ${result.rows.map((r) => r.table_name).join(", ")}`);
await handle.close();
