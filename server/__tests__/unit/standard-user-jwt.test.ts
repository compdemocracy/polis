import {
  issueStandardUserJWT,
  isStandardUserJWT,
  verifyStandardUserJWT,
} from "../../src/auth/standard-user-jwt";
import jwt from "jsonwebtoken";

describe("Standard User JWT", () => {
  const mockAuth0Sub = "auth0|123456789";
  const mockConversationId = "test-conversation";
  const mockUid = 123;
  const mockPid = 456;

  describe("issueStandardUserJWT", () => {
    it("should issue a valid JWT with correct claims", () => {
      const token = issueStandardUserJWT(
        mockAuth0Sub,
        mockConversationId,
        mockUid,
        mockPid
      );

      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");

      // Decode without verification to check structure
      const decoded = jwt.decode(token) as any;
      expect(decoded).toBeTruthy();
      expect(decoded.auth0_sub).toBe(mockAuth0Sub);
      expect(decoded.sub).toBe(`user:${mockAuth0Sub}`);
      expect(decoded.uid).toBe(mockUid);
      expect(decoded.pid).toBe(mockPid);
      expect(decoded.conversation_id).toBe(mockConversationId);
      expect(decoded.standard_user_participant).toBe(true);
      expect(decoded.aud).toBeTruthy();
      expect(decoded.iss).toBeTruthy();
      expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
      expect(decoded.iat).toBeLessThanOrEqual(Date.now() / 1000);
    });

    it("should create tokens with 24-hour expiration", () => {
      const token = issueStandardUserJWT(
        mockAuth0Sub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const decoded = jwt.decode(token) as any;
      const expirationTime = decoded.exp - decoded.iat;
      expect(expirationTime).toBe(24 * 60 * 60); // 24 hours in seconds
    });
  });

  describe("isStandardUserJWT", () => {
    it("should correctly identify standard user JWTs", () => {
      const token = issueStandardUserJWT(
        mockAuth0Sub,
        mockConversationId,
        mockUid,
        mockPid
      );

      expect(isStandardUserJWT(token)).toBe(true);
    });

    it("should return false for non-standard user JWTs", () => {
      // Create a mock JWT without standard user claims
      const mockToken = jwt.sign(
        {
          uid: 123,
          pid: 456,
          // Missing standard_user_participant and auth0_sub
        },
        "mock-secret"
      );

      expect(isStandardUserJWT(mockToken)).toBe(false);
    });

    it("should return false for invalid tokens", () => {
      expect(isStandardUserJWT("invalid-token")).toBe(false);
      expect(isStandardUserJWT("")).toBe(false);
    });

    it("should return false for JWTs with partial standard user claims", () => {
      // Has auth0_sub but not standard_user_participant
      const partialToken1 = jwt.sign(
        {
          auth0_sub: mockAuth0Sub,
          uid: 123,
          pid: 456,
        },
        "mock-secret"
      );

      // Has standard_user_participant but not auth0_sub
      const partialToken2 = jwt.sign(
        {
          standard_user_participant: true,
          uid: 123,
          pid: 456,
        },
        "mock-secret"
      );

      expect(isStandardUserJWT(partialToken1)).toBe(false);
      expect(isStandardUserJWT(partialToken2)).toBe(false);
    });
  });

  describe("verifyStandardUserJWT", () => {
    it("should verify and return claims for valid standard user JWT", () => {
      const token = issueStandardUserJWT(
        mockAuth0Sub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const claims = verifyStandardUserJWT(token);
      expect(claims.auth0_sub).toBe(mockAuth0Sub);
      expect(claims.sub).toBe(`user:${mockAuth0Sub}`);
      expect(claims.uid).toBe(mockUid);
      expect(claims.pid).toBe(mockPid);
      expect(claims.conversation_id).toBe(mockConversationId);
      expect(claims.standard_user_participant).toBe(true);
    });

    it("should throw error for invalid standard user JWT", () => {
      const invalidToken = "invalid.jwt.token";

      expect(() => verifyStandardUserJWT(invalidToken)).toThrow(
        "Invalid standard user JWT"
      );
    });

    it("should throw error for JWT missing required claims", () => {
      // This would need a valid private key to sign, but for testing
      // we can verify the validation logic throws appropriately
      const mockTokenWithoutClaims = jwt.sign(
        {
          uid: 123,
          pid: 456,
          // Missing required standard user claims
        },
        "mock-secret"
      );

      expect(() => verifyStandardUserJWT(mockTokenWithoutClaims)).toThrow();
    });
  });

  describe("Standard User JWT vs Other JWT Types", () => {
    it("should have different structure than XID JWT", () => {
      const standardUserToken = issueStandardUserJWT(
        mockAuth0Sub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const decoded = jwt.decode(standardUserToken) as any;

      // Standard user JWTs should have auth0_sub instead of xid
      expect(decoded.auth0_sub).toBeTruthy();
      expect(decoded.xid).toBeUndefined();
      expect(decoded.xid_participant).toBeUndefined();
      expect(decoded.standard_user_participant).toBe(true);
    });

    it("should have different structure than Anonymous JWT", () => {
      const standardUserToken = issueStandardUserJWT(
        mockAuth0Sub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const decoded = jwt.decode(standardUserToken) as any;

      // Standard user JWTs should have auth0_sub
      expect(decoded.auth0_sub).toBeTruthy();
      expect(decoded.anonymous_participant).toBeUndefined();
      expect(decoded.standard_user_participant).toBe(true);
      expect(decoded.sub).toMatch(/^user:/);
    });
  });
});
