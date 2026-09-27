/**
 * Regression test for the duplicate rejection every failing query produced.
 *
 * queryImpl (server/src/db/pg-query.ts) both invokes the caller's callback and
 * settles a promise it returns. queryP_impl — the base of queryP,
 * queryP_readOnly and everything built on them — supplies a callback and
 * discards that promise, so every failed query rejected twice: once through
 * the promise the caller awaits, and once into a promise nobody ever observed.
 * The second one reached the process 'unhandledRejection' handler, which is
 * why the characterization harness recorded "process error during case" on
 * routes that had answered correctly (42601, 42P01, 23505, 23502, 22P02).
 */
import { describe, expect, test } from "@jest/globals";
import pg from "../../src/db/pg-query";

describe("pg-query error propagation", () => {
  test("a failing queryP rejects its caller and nothing else", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      await expect(
        pg.queryP("select * from p029_no_such_relation;", [])
      ).rejects.toMatchObject({ code: "42P01" });

      // Two turns of the loop: an unobserved rejection is reported on the next
      // tick after the promise settles.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("a failing callback-style query reports through the callback only", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const err = await new Promise<any>((resolve) => {
        pg.query("select * from p029_no_such_relation;", [], (e: any) =>
          resolve(e)
        );
      });

      expect(err).toBeTruthy();
      expect(err.code).toBe("42P01");

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
