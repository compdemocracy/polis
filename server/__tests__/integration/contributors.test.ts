/**
 * Regression test for POST /api/v3/contributors.
 *
 * The handler inserts into `contributor_agreement_signatures`, a relation that
 * no migration in server/postgres/migrations creates. On every schema built
 * from this repository the insert fails with 42P01 (undefined_table), which
 * the handler reported as the generic polis_err_POST_contributors_misc 500.
 * The route now names the real condition, and — with the duplicate pg
 * rejection fixed — answers without raising a process-level unhandled
 * rejection.
 */
import { describe, expect, test } from "@jest/globals";
import { newAgent } from "../setup/api-test-helpers";

describe("POST /api/v3/contributors", () => {
  test("answers 503 with a code naming the missing relation", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const agent = await newAgent();
      const response = await agent.post("/api/v3/contributors").send({
        agreement_version: 1,
        name: "P-029 Regression",
        email: "p029.contributor@polis.test",
        github_id: "p029",
        company_name: "None",
      });

      expect(response.status).toBe(503);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_contributors_unavailable"
      );

      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("the relation really is absent from the schema", async () => {
    const pg = (await import("../../src/db/pg-query")).default;
    const rows = (await pg.queryP(
      "select to_regclass('public.contributor_agreement_signatures') as rel;",
      []
    )) as Array<{ rel: string | null }>;

    expect(rows[0].rel).toBeNull();
  });
});
