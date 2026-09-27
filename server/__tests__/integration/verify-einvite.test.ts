/**
 * Regression test for GET /api/v3/verify.
 *
 * When the einvite was unknown the handler called failJson and then fell
 * through to `rows[0].email`. The resulting TypeError was caught by the
 * chain's .catch, which called failJson a second time, and Express raised
 * ERR_HTTP_HEADERS_SENT ("Cannot set headers after they are sent to the
 * client") as an unhandled rejection on the process.
 *
 * The response the client sees is unchanged — 500
 * polis_err_verification_missing — but it is now written exactly once.
 */
import { describe, expect, test } from "@jest/globals";
import { newAgent } from "../setup/api-test-helpers";

describe("GET /api/v3/verify", () => {
  test("an unknown einvite answers once and sets no headers twice", async () => {
    const rejections: unknown[] = [];
    const uncaught: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onUncaught);

    try {
      const agent = await newAgent();
      const response = await agent.get(
        `/api/v3/verify?e=p029-no-such-einvite-${Date.now()}`
      );

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_verification_missing"
      );
      // The success continuation must not have run.
      expect(response.text).not.toContain("Email verified!");

      await new Promise((resolve) => setImmediate(resolve));

      const headersSent = [...rejections, ...uncaught].filter((e: any) =>
        String(e?.code ?? e).includes("ERR_HTTP_HEADERS_SENT")
      );
      expect(headersSent).toHaveLength(0);
      expect(rejections).toHaveLength(0);
      expect(uncaught).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onUncaught);
    }
  });
});
