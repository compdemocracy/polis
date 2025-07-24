import {
  issueStandardUserJWT,
  isStandardUserJWT,
  verifyStandardUserJWT,
} from "../../src/auth/standard-user-jwt";
import jwt from "jsonwebtoken";

describe("Standard User JWT", () => {
  const mockOidcSub = "auth0|123456789";
  const mockConversationId = "test-conversation";
  const mockUid = 123;
  const mockPid = 456;

  describe("issueStandardUserJWT", () => {
    it("should issue a valid JWT with correct claims", () => {
      const token = issueStandardUserJWT(
        mockOidcSub,
        mockConversationId,
        mockUid,
        mockPid
      );

      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");

      // Decode without verification to check structure
      const decoded = jwt.decode(token) as any;
      expect(decoded).toBeTruthy();
      expect(decoded.oidc_sub).toBe(mockOidcSub);
      expect(decoded.sub).toBe(`user:${mockOidcSub}`);
      expect(decoded.uid).toBe(mockUid);
      expect(decoded.pid).toBe(mockPid);
      expect(decoded.conversation_id).toBe(mockConversationId);
      expect(decoded.standard_user_participant).toBe(true);
      expect(decoded.aud).toBeTruthy();
      expect(decoded.iss).toBeTruthy();
      expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
      expect(decoded.iat).toBeLessThanOrEqual(Date.now() / 1000);
    });

    it("should create tokens with 1-year expiration", () => {
      const token = issueStandardUserJWT(
        mockOidcSub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const decoded = jwt.decode(token) as any;
      const expirationTime = decoded.exp - decoded.iat;
      expect(expirationTime).toBe(365 * 24 * 60 * 60); // 1 year in seconds
    });
  });

  describe("isStandardUserJWT", () => {
    it("should correctly identify standard user JWTs", () => {
      const token = issueStandardUserJWT(
        mockOidcSub,
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
          // Missing standard_user_participant and oidc_sub
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
      // Has oidc_sub but not standard_user_participant
      const partialToken1 = jwt.sign(
        {
          oidc_sub: mockOidcSub,
          uid: 123,
          pid: 456,
        },
        "mock-secret"
      );

      // Has standard_user_participant but not oidc_sub
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
        mockOidcSub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const claims = verifyStandardUserJWT(token);
      expect(claims.oidc_sub).toBe(mockOidcSub);
      expect(claims.sub).toBe(`user:${mockOidcSub}`);
      expect(claims.uid).toBe(mockUid);
      expect(claims.pid).toBe(mockPid);
      expect(claims.conversation_id).toBe(mockConversationId);
      expect(claims.standard_user_participant).toBe(true);
    });

    it("should throw error for invalid standard user JWT", () => {
      const invalidToken = "invalid.jwt.token";

      expect(() => verifyStandardUserJWT(invalidToken)).toThrow(
        "Invalid standard_user JWT"
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
        mockOidcSub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const decoded = jwt.decode(standardUserToken) as any;

      // Standard user JWTs should have oidc_sub instead of xid
      expect(decoded.oidc_sub).toBeTruthy();
      expect(decoded.xid).toBeUndefined();
      expect(decoded.xid_participant).toBeUndefined();
      expect(decoded.standard_user_participant).toBe(true);
    });

    it("should have different structure than Anonymous JWT", () => {
      const standardUserToken = issueStandardUserJWT(
        mockOidcSub,
        mockConversationId,
        mockUid,
        mockPid
      );

      const decoded = jwt.decode(standardUserToken) as any;

      // Standard user JWTs should have oidc_sub
      expect(decoded.oidc_sub).toBeTruthy();
      expect(decoded.anonymous_participant).toBeUndefined();
      expect(decoded.standard_user_participant).toBe(true);
      expect(decoded.sub).toMatch(/^user:/);
    });
  });
});
