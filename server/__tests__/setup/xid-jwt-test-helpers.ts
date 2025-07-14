import { issueXidJWT } from "../../src/auth/xid-jwt";
import { newAgent } from "./api-test-helpers";
import { expect } from "@jest/globals";

export interface XidJwtTestUser {
  xid: string;
  conversationId: string;
  uid: number;
  pid: number;
  token?: string;
}

/**
 * Create a test XID user with JWT
 * This simulates what happens when an XID participant is created
 */
export function createXidTestUser(
  conversationId: string,
  xid?: string
): XidJwtTestUser {
  const testXid =
    xid || `test-xid-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  // In real usage, these would come from the database after participant creation
  const uid = Math.floor(Math.random() * 100000); // Simulated UID
  const pid = Math.floor(Math.random() * 100000); // Simulated PID

  return {
    xid: testXid,
    conversationId,
    uid,
    pid,
  };
}

/**
 * Get an authenticated agent for an XID user
 * This simulates the full flow of an XID participant getting a JWT
 */
export async function getXidAuthenticatedAgent(xidUser: XidJwtTestUser) {
  const agent = await newAgent();

  // Issue JWT for the XID user
  const token = issueXidJWT(
    xidUser.xid,
    xidUser.conversationId,
    xidUser.uid,
    xidUser.pid
  );

  // Set the authorization header
  agent.set("Authorization", `Bearer ${token}`);

  return {
    agent,
    token,
    xidUser: { ...xidUser, token },
  };
}

/**
 * Simulate the full XID participant initialization flow
 * This mimics what happens when a real XID user joins a conversation
 */
export async function simulateXidParticipantFlow(
  conversationId: string,
  xid?: string
) {
  const agent = await newAgent();

  // Step 1: Initial participation request (no JWT yet)
  const initResponse = await agent.get(
    `/api/v3/participationInit?conversation_id=${conversationId}&xid=${xid}&agid=1`
  );

  // Step 2: If user was created, they get a JWT in the response
  if (initResponse.body.auth && initResponse.body.auth.token) {
    const token = initResponse.body.auth.token;

    // Step 3: Use the JWT for subsequent requests
    agent.set("Authorization", `Bearer ${token}`);

    return {
      agent,
      token,
      initResponse: initResponse.body,
      xid: xid || initResponse.body.user?.xid,
    };
  }

  // No JWT was issued (user might not exist yet)
  return {
    agent,
    token: null,
    initResponse: initResponse.body,
    xid,
  };
}

/**
 * Test helper to verify XID JWT claims
 */
export function verifyXidJwtClaims(token: string) {
  // Decode the JWT without verification (for testing)
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());

  // Verify XID-specific claims
  expect(payload).toHaveProperty("xid");
  expect(payload).toHaveProperty("xid_participant", true);
  expect(payload).toHaveProperty("conversation_id");
  expect(payload.sub).toMatch(/^xid:/);

  return payload;
}
