import { defineConfig } from "drizzle-kit";

// One schema, one set of SQL migrations — applied to PGlite (dev/test) and PostgreSQL (prod).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});
