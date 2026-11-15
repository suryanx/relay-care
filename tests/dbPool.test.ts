import pg from "pg";
import { describe, expect, it } from "vitest";
import { attachPoolErrorHandler } from "../src/server/db/client.js";

describe("PostgreSQL pool error handling", () => {
  it("logs idle-connection errors instead of crashing, without sensitive details", () => {
    // No connection is opened: the pool is only created, then an idle-client error is simulated.
    const url = "postgres://relay_user:super-secret-pass@db.example.test:5432/relay?sslmode=verify-full";
    const pool = new pg.Pool({ connectionString: url });
    const lines: string[] = [];
    attachPoolErrorHandler(pool, (l) => lines.push(l));

    const err = Object.assign(new Error(`Connection terminated unexpectedly for ${url}`), { code: "57P01" });
    expect(() => pool.emit("error", err)).not.toThrow(); // without a listener, emit("error") throws

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("57P01");
    for (const sensitive of ["super-secret-pass", "relay_user", "db.example.test", "postgres://"]) {
      expect(lines[0]).not.toContain(sensitive);
    }
    return pool.end();
  });

  it("an unhandled pool error would throw (why the handler matters)", () => {
    const pool = new pg.Pool({ connectionString: "postgres://u:p@db.example.test/x" });
    expect(() => pool.emit("error", new Error("boom"))).toThrow("boom");
    return pool.end();
  });
});
