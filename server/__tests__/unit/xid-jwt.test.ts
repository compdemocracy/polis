import { describe, expect, test } from "@jest/globals";
import { issueXidJWT, isXidJWT, verifyXidJWT } from "../../src/auth/xid-jwt";
import jwt from "jsonwebtoken";

describe("XID JWT Implementation", () => {
  const testXid = "test-external-id-123";
  const testConversationId = "conv-456";
  const testUid = 789;
  const testPid = 37;

  let testToken: string;

  test("should issue a valid XID JWT", () => {
    testToken = issueXidJWT(testXid, testConversationId, testUid, testPid);

    expect(testToken).toBeDefined();
    expect(typeof testToken).toBe("string");

    // Should be a valid JWT structure (3 parts separated by dots)
    const parts = testToken.split(".");
    expect(parts).toHaveLength(3);
  });

  test("should correctly identify XID JWTs", () => {
    expect(isXidJWT(testToken)).toBe(true);

    // Create a fake OIDC JWT to test discrimination
    const fakeOidcToken = jwt.sign(
      {
        sub: "auth0|123456",
        aud: "test-audience",
        iss: "https://test.auth0.com/",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "fake-secret"
    );

    expect(isXidJWT(fakeOidcToken)).toBe(false);

    // Test with invalid token
    expect(isXidJWT("invalid.token.here")).toBe(false);
    expect(isXidJWT("")).toBe(false);
  });

  test("should verify and decode XID JWT correctly", () => {
    const decoded = verifyXidJWT(testToken);

    expect(decoded).toBeDefined();
    expect(decoded.xid).toBe(testXid);
    expect(decoded.conversation_id).toBe(testConversationId);
    expect(decoded.uid).toBe(testUid);
    expect(decoded.pid).toBe(testPid);
    expect(decoded.sub).toBe(`xid:${testXid}`);
    expect(decoded.xid_participant).toBe(true);

    // Check standard JWT claims
    expect(decoded.aud).toBeDefined();
    expect(decoded.iss).toBeDefined();
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();

    // Verify expiration is in the future (1 year)
    const now = Math.floor(Date.now() / 1000);
    expect(decoded.exp).toBeGreaterThan(now);
    expect(decoded.exp).toBeLessThanOrEqual(now + 365 * 24 * 60 * 60 + 1); // Allow 1 second tolerance
  });

  test("should reject invalid XID JWT", () => {
    // Test with expired token
    const expiredToken = jwt.sign(
      {
        xid: testXid,
        sub: `xid:${testXid}`,
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        xid_participant: true,
      },
      "wrong-secret"
    );

    expect(() => verifyXidJWT(expiredToken)).toThrow();

    // Test with missing XID claims
    const invalidToken = jwt.sign(
      {
        sub: "regular-user",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "wrong-secret"
    );

    expect(() => verifyXidJWT(invalidToken)).toThrow();
  });

  test("should have proper JWT structure and claims", () => {
    // Decode without verification to check structure
    const decoded = jwt.decode(testToken, { complete: true }) as any;

    expect(decoded).toBeDefined();
    expect(decoded.header).toBeDefined();
    expect(decoded.payload).toBeDefined();
    expect(decoded.signature).toBeDefined();

    // Check header
    expect(decoded.header.alg).toBe("RS256");
    expect(decoded.header.typ).toBe("JWT");

    // Check payload structure
    const payload = decoded.payload;
    expect(payload.xid).toBe(testXid);
    expect(payload.sub).toBe(`xid:${testXid}`);
    expect(payload.conversation_id).toBe(testConversationId);
    expect(payload.uid).toBe(testUid);
    expect(payload.pid).toBe(testPid);
    expect(payload.xid_participant).toBe(true);
  });

  test("should work with different XID values", () => {
    const testCases = [
      "simple-xid",
      "xid_with_underscores",
      "xid-with-dashes",
      "XID_WITH_CAPS",
      "12345",
      "user@example.com",
      "complex.xid+test@domain.com",
    ];

    testCases.forEach((xid) => {
      const token = issueXidJWT(xid, testConversationId, testUid, testPid);
      expect(isXidJWT(token)).toBe(true);

      const decoded = verifyXidJWT(token);
      expect(decoded.xid).toBe(xid);
      expect(decoded.sub).toBe(`xid:${xid}`);
    });
  });
});
