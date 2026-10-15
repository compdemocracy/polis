import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  createConversation,
  getJwtAuthenticatedAgent,
} from "../setup/api-test-helpers";
import {
  getPooledTestUser,
  RESERVED_POOLED_USER_INDEXES,
} from "../setup/test-user-helpers";
import type { Agent, Response } from "supertest";

// GET /api/v3/conversations used to create a single-use suzinvite row for every
// listed conversation whenever an `xid` query parameter was present, and point
// each conversation's url at the resulting single-use /ot/ join link — a write
// performed by a read route, with no owner check, recording invitations against
// the conversation owner. That side effect has been removed: the xid parameter
// no longer creates suzinvites rows, and the listed url is the ordinary
// conversation url.
describe("GET /api/v3/conversations?xid= has no suzinvite side effect", () => {
  let ownerAgent: Agent;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;

  beforeAll(async () => {
    ({ pool } = await import("../setup/db-test-helpers"));

    const ownerUser = getPooledTestUser(
      RESERVED_POOLED_USER_INDEXES.conversationsXidSuzinvite
    );
    ({ agent: ownerAgent } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    }));

    // Ensure the owner has at least one conversation so the listing is non-empty
    // (before the fix, each listed conversation produced a suzinvites row).
    await createConversation(ownerAgent, {
      topic: "Conversations xid side-effect test",
      description: "The xid parameter must not create suzinvites",
    });
  });

  test("passing xid writes no suzinvites row and returns an ordinary url", async () => {
    const xid = `xid-no-side-effect-${Date.now()}-${Math.floor(
      Math.random() * 1e6
    )}`;

    const before = await pool.query(
      "SELECT COUNT(*)::int AS n FROM suzinvites WHERE xid = $1",
      [xid]
    );
    expect(before.rows[0].n).toBe(0);

    // List the owner's conversations with an xid present. This is the path
    // (no conversation_id) that ran processConversationData, where the side
    // effect lived: before the fix it wrote one suzinvites row per listed
    // conversation. The owner has at least the conversation created above.
    const r: Response = await ownerAgent.get(
      `/api/v3/conversations?xid=${encodeURIComponent(xid)}`
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThan(0);

    // The returned url is an ordinary conversation url, not a single-use /ot/
    // join link.
    for (const conv of r.body) {
      expect(typeof conv.url).toBe("string");
      expect(conv.url).not.toContain("/ot/");
    }

    const after = await pool.query(
      "SELECT COUNT(*)::int AS n FROM suzinvites WHERE xid = $1",
      [xid]
    );
    expect(after.rows[0].n).toBe(0);
  });
});
