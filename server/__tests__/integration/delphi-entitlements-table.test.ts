/**
 * The table that records which accounts may use Polis 2
 * (server/postgres/migrations/000048_create_delphi_entitlements.sql), against
 * the test database the migrations built: one row per account, a closed set
 * of sources, a row that goes with its account, and a grant that outlives the
 * account that granted it.
 *
 * No server code writes this table yet; these rows are written here directly.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "crypto";
import { pool } from "../setup/db-test-helpers";

async function account(): Promise<number> {
  const { rows } = await pool.query(
    "INSERT INTO users (email) VALUES ($1) RETURNING uid",
    [`entitlement-${randomUUID()}@example.invalid`]
  );
  return rows[0].uid;
}

async function code(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await pool.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

describe("delphi_entitlements", () => {
  const made: number[] = [];
  const fresh = async () => {
    const uid = await account();
    made.push(uid);
    return uid;
  };

  beforeAll(async () => {
    const { rows } = await pool.query(
      "SELECT to_regclass('public.delphi_entitlements') AS t"
    );
    expect(rows[0].t).toBe("delphi_entitlements");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM delphi_entitlements WHERE uid = ANY($1)", [
      made,
    ]);
    await pool.query("DELETE FROM users WHERE uid = ANY($1)", [made]);
  });

  test("has exactly the four columns, with these types and nullability", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'delphi_entitlements'
        ORDER BY ordinal_position`
    );
    expect(rows).toEqual([
      {
        column_name: "uid",
        data_type: "integer",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "granted_at",
        data_type: "bigint",
        is_nullable: "NO",
        column_default: "now_as_millis()",
      },
      {
        column_name: "granted_by",
        data_type: "integer",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "source",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
    ]);
  });

  test("has no trigger and no rule", async () => {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM pg_trigger
                WHERE tgrelid = 'public.delphi_entitlements'::regclass
                  AND NOT tgisinternal)::int AS triggers,
              (SELECT count(*) FROM pg_rules
                WHERE schemaname = 'public'
                  AND tablename = 'delphi_entitlements')::int AS rules`
    );
    expect(rows[0]).toEqual({ triggers: 0, rules: 0 });
  });

  test("records a grant from either source, timestamped by default", async () => {
    const granter = await fresh();
    const [a, b] = [await fresh(), await fresh()];
    const before = Date.now();
    await pool.query(
      "INSERT INTO delphi_entitlements (uid, granted_by, source) VALUES ($1, $2, 'site_admin'), ($3, NULL, 'auth0_role')",
      [a, granter, b]
    );
    const { rows } = await pool.query(
      "SELECT uid, granted_by, source, granted_at FROM delphi_entitlements WHERE uid = ANY($1) ORDER BY uid",
      [[a, b]]
    );
    expect(
      rows.map(({ uid, granted_by, source }) => ({ uid, granted_by, source }))
    ).toEqual([
      { uid: a, granted_by: granter, source: "site_admin" },
      { uid: b, granted_by: null, source: "auth0_role" },
    ]);
    for (const row of rows) {
      expect(Number(row.granted_at)).toBeGreaterThanOrEqual(before - 60000);
      expect(Number(row.granted_at)).toBeLessThanOrEqual(Date.now() + 60000);
    }
  });

  test("refuses a second row for one account", async () => {
    const uid = await fresh();
    await pool.query(
      "INSERT INTO delphi_entitlements (uid, source) VALUES ($1, 'site_admin')",
      [uid]
    );
    expect(
      await code(
        "INSERT INTO delphi_entitlements (uid, source) VALUES ($1, 'auth0_role')",
        [uid]
      )
    ).toBe("23505");
  });

  test.each(["", "Site_admin", "claim", "conversation_owner"])(
    "refuses the source %p, outside the closed set",
    async (source) => {
      const uid = await fresh();
      expect(
        await code(
          "INSERT INTO delphi_entitlements (uid, source) VALUES ($1, $2)",
          [uid, source]
        )
      ).toBe("23514");
    }
  );

  test("refuses a missing source or time", async () => {
    const uid = await fresh();
    expect(
      await code("INSERT INTO delphi_entitlements (uid) VALUES ($1)", [uid])
    ).toBe("23502");
    expect(
      await code(
        "INSERT INTO delphi_entitlements (uid, source, granted_at) VALUES ($1, 'site_admin', NULL)",
        [uid]
      )
    ).toBe("23502");
  });

  test("refuses an account or a granter that does not exist", async () => {
    const uid = await fresh();
    const { rows } = await pool.query(
      "SELECT coalesce(max(uid), 0) + 1000 AS absent FROM users"
    );
    const absent = Number(rows[0].absent);
    expect(
      await code(
        "INSERT INTO delphi_entitlements (uid, source) VALUES ($1, 'site_admin')",
        [absent]
      )
    ).toBe("23503");
    expect(
      await code(
        "INSERT INTO delphi_entitlements (uid, granted_by, source) VALUES ($1, $2, 'site_admin')",
        [uid, absent]
      )
    ).toBe("23503");
  });

  test("deleting an account deletes its row; deleting its granter keeps the row", async () => {
    const granter = await account();
    const holder = await account();
    await pool.query(
      "INSERT INTO delphi_entitlements (uid, granted_by, source) VALUES ($1, $2, 'site_admin')",
      [holder, granter]
    );
    await pool.query("DELETE FROM users WHERE uid = $1", [granter]);
    const kept = await pool.query(
      "SELECT granted_by, source FROM delphi_entitlements WHERE uid = $1",
      [holder]
    );
    expect(kept.rows).toEqual([{ granted_by: null, source: "site_admin" }]);

    await pool.query("DELETE FROM users WHERE uid = $1", [holder]);
    const gone = await pool.query(
      "SELECT 1 FROM delphi_entitlements WHERE uid = $1",
      [holder]
    );
    expect(gone.rows).toEqual([]);
  });
});
