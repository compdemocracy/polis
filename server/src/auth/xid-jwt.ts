/**
 * Custom JWT implementation for anonymous and XID users
 *
 * Why not use OIDC for these users?
 * 1. OIDC is designed for authenticated identities, not anonymous sessions
 * 2. Creating OIDC users for every anonymous participant would:
 *    - Pollute the user database with temporary records
 *    - Incur unnecessary API calls and potential rate limits
 *    - Add complexity without benefit
 * 3. XID users need tokens scoped to specific conversations
 * 4. This approach maintains JWT consistency while keeping anonymous users separate
 *
 * Security considerations:
 * - Uses RSA-256 with 2048-bit keys (industry standard)
 * - Tokens are short-lived (24 hours)
 * - Tokens are scoped to specific conversations
 * - No refresh mechanism (participants must re-initialize)
 */

import { expressjwt } from "express-jwt";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import path from "node:path";

import Config from "../config";
import logger from "../utils/logger";

interface XidJwtClaims {
  aud: string; // Audience
  exp: number; // Expiration time
  iat: number; // Issued at time
  iss: string; // Issuer
  pid: number; // Participant ID
  sub: string; // "xid:<external_id>"
  uid: number; // Local user ID
  xid: string; // External ID
  conversation_id: string; // Conversation ID
  xid_participant: boolean; // XID participant flag
}

// Private key for signing XID JWTs (separate from OIDC)
function _getPrivateKey(): string {
  const keyPath =
    Config.jwtPrivateKeyPath ||
    path.join(__dirname, "../../keys/jwt-private.pem");

  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    logger.error("Failed to load XID JWT private key:", error);
    // Fallback to environment variable for containerized deployments
    const envKey = Config.jwtPrivateKey;
    if (!envKey) {
      throw new Error(
        "XID JWT private key not found. Set XID_JWT_PRIVATE_KEY_PATH or JWT_PRIVATE_KEY"
      );
    }
    return envKey.replace(/\\n/g, "\n"); // Handle escaped newlines
  }
}

// Public key for validating XID JWTs
function _getPublicKey(): string {
  const keyPath =
    Config.jwtPublicKeyPath ||
    path.join(__dirname, "../../keys/jwt-public.pem");

  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    logger.error("Failed to load XID JWT public key:", error);
    // Fallback to environment variable
    const envKey = Config.jwtPublicKey;
    if (!envKey) {
      throw new Error(
        "XID JWT public key not found. Set XID_JWT_PUBLIC_KEY_PATH or JWT_PUBLIC_KEY"
      );
    }
    return envKey.replace(/\\n/g, "\n");
  }
}

// Check if a token is an XID JWT by examining its structure
function isXidJWT(token: string): boolean {
  try {
    // Decode without verification to check claims
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      return false;
    }

    const payload = decoded.payload;

    // XID JWTs have specific claims that OIDC JWTs don't have
    return !!(payload.xid_participant && payload.xid);
  } catch (error) {
    logger.error("Error checking if token is XID JWT:", error);
    return false;
  }
}

// Issue a new XID JWT
function issueXidJWT(
  xid: string,
  conversationId: string,
  uid: number,
  pid: number
): string {
  const payload: XidJwtClaims = {
    aud: Config.polisJwtAudience as string,
    iss: Config.polisJwtIssuer as string,
    pid,
    uid,
    xid,
    sub: `xid:${xid}`,
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
    iat: Math.floor(Date.now() / 1000),
    conversation_id: conversationId,
    xid_participant: true,
  };

  try {
    const privateKey = _getPrivateKey();
    return jwt.sign(payload, privateKey, { algorithm: "RS256" });
  } catch (error) {
    logger.error("Failed to sign XID JWT:", error);
    throw new Error("Failed to create XID authentication token");
  }
}

// Validate XID JWT middleware
const xidJwtValidation = expressjwt({
  secret: () => {
    try {
      return _getPublicKey();
    } catch (error) {
      logger.error("Failed to get public key for XID JWT validation:", error);
      throw error;
    }
  },
  audience: Config.polisJwtAudience as string,
  issuer: Config.polisJwtIssuer as string,
  algorithms: ["RS256"],
  requestProperty: "xidJwtPayload",
});

// Optional XID JWT validation - doesn't fail if no token is present
const xidJwtValidationOptional = expressjwt({
  secret: () => {
    try {
      return _getPublicKey();
    } catch (error) {
      logger.error(
        "Failed to get public key for optional XID JWT validation:",
        error
      );
      throw error;
    }
  },
  audience: Config.polisJwtAudience as string,
  issuer: Config.polisJwtIssuer as string,
  algorithms: ["RS256"],
  credentialsRequired: false,
  requestProperty: "xidJwtPayload",
});

// Extract XID user info from JWT and assign to request
const extractUserFromXidJWT = (
  assigner?: (req: any, key: string, value: any) => void
) => {
  return async (req: any, res: any, next: any) => {
    try {
      if (req.xidJwtPayload) {
        logger.debug("XID JWT user info:", req.xidJwtPayload);

        const payload = req.xidJwtPayload as XidJwtClaims;

        // Validate that this is actually an XID JWT
        if (
          !payload.xid_participant ||
          !payload.xid ||
          !payload.sub?.startsWith("xid:")
        ) {
          logger.error("Invalid XID JWT claims:", payload);
          return next(new Error("Invalid XID JWT format"));
        }

        // Check conversation scoping but don't error - just set flags
        const requestedConversationId =
          req.query?.conversation_id || req.body?.conversation_id;

        // Set up the request parameters for downstream handlers using assigner function
        req.p = req.p || {};

        // Store XID-specific data that doesn't conflict with standard parameters
        req.p.xid = payload.xid;
        req.p.pid = payload.pid;
        req.p.conversation_id = payload.conversation_id;
        req.p.xid_participant = payload.xid_participant;

        // Set conversation mismatch flags
        if (
          requestedConversationId &&
          payload.conversation_id !== requestedConversationId
        ) {
          req.p.jwt_conversation_mismatch = true;
          req.p.jwt_conversation_id = payload.conversation_id;
          req.p.requested_conversation_id = requestedConversationId;
          req.p.jwt_xid = payload.xid; // Store the XID from the JWT
          logger.debug(
            `XID JWT conversation mismatch detected: token for ${payload.conversation_id}, request for ${requestedConversationId}, XID: ${payload.xid}`
          );
        } else {
          req.p.jwt_conversation_mismatch = false;
        }

        // Use the assigner function for standard parameters (canonical parameter middleware pattern)
        if (assigner) {
          assigner(req, "uid", payload.uid);
          assigner(req, "xid", payload.xid);
        }

        logger.debug(
          `Successfully extracted XID participant: ${payload.xid} -> uid: ${payload.uid}, mismatch: ${req.p.jwt_conversation_mismatch}`
        );
      } else {
        logger.warn("No XID JWT payload found in request");
      }
      next();
    } catch (error) {
      logger.error("Error extracting user from XID JWT:", error);
      next(error);
    }
  };
};

// Verify an XID JWT manually (for custom validation scenarios)
function verifyXidJWT(token: string): XidJwtClaims {
  try {
    const publicKey = _getPublicKey();
    const payload = jwt.verify(token, publicKey, {
      audience: Config.polisJwtAudience as string,
      issuer: Config.polisJwtIssuer as string,
      algorithms: ["RS256"],
    }) as XidJwtClaims;

    // Additional XID-specific validation
    if (
      !payload.xid_participant ||
      !payload.xid ||
      !payload.sub?.startsWith("xid:")
    ) {
      throw new Error("Invalid XID JWT claims");
    }

    return payload;
  } catch (error) {
    logger.error("XID JWT verification failed:", error);
    throw new Error("Invalid XID JWT");
  }
}

export {
  extractUserFromXidJWT,
  issueXidJWT,
  isXidJWT,
  verifyXidJWT,
  xidJwtValidation,
  xidJwtValidationOptional,
};
