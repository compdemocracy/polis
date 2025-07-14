/**
 * JWT implementation for anonymous participants (without XIDs)
 *
 * This extends the JWT-based authentication to anonymous participants,
 * providing consistency across all participant types while maintaining
 * the conversation-scoped security model.
 *
 * Key differences from XID JWT:
 * - No xid field in the payload
 * - Subject format is "anon:<uid>" instead of "xid:<external_id>"
 * - Used for participants who join without any external identity
 *
 * Security considerations:
 * - Uses same RSA-256 encryption as XID JWTs
 * - Tokens are conversation-scoped
 * - 24-hour expiration
 * - No refresh mechanism
 */

import { expressjwt } from "express-jwt";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import Config from "../config";
import logger from "../utils/logger";

interface AnonymousJwtClaims {
  aud: string; // Audience
  exp: number; // Expiration time
  iat: number; // Issued at time
  iss: string; // Issuer
  pid: number; // Participant ID
  sub: string; // "anon:<uid>"
  uid: number; // Local user ID
  conversation_id: string; // Conversation ID
  anonymous_participant: boolean; // Anonymous participant flag
}

// Use the same keys as XID JWT for consistency
function _getPrivateKey(): string {
  const keyPath = Config.jwtPrivateKeyPath;

  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    logger.error("Failed to load private key for anonymous JWT:", error);
    const envKey = Config.jwtPrivateKey;
    if (!envKey) {
      throw new Error(
        "JWT private key not found. Set JWT_PRIVATE_KEY_PATH or JWT_PRIVATE_KEY"
      );
    }
    return envKey.replace(/\\n/g, "\n");
  }
}

function _getPublicKey(): string {
  const keyPath = Config.jwtPublicKeyPath;

  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    logger.error("Failed to load public key for anonymous JWT:", error);
    const envKey = Config.jwtPublicKey;
    if (!envKey) {
      throw new Error(
        "JWT public key not found. Set JWT_PUBLIC_KEY_PATH or JWT_PUBLIC_KEY"
      );
    }
    return envKey.replace(/\\n/g, "\n");
  }
}

// Check if a token is an anonymous JWT
function isAnonymousJWT(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      return false;
    }

    const payload = decoded.payload;

    // Anonymous JWTs have specific claims
    return !!(
      (payload.anonymous_participant && !payload.xid) // Ensure it's not an XID JWT
    );
  } catch (error) {
    logger.warn("Error checking if token is anonymous JWT:", error);
    return false;
  }
}

// Issue a new anonymous JWT
function issueAnonymousJWT(
  conversationId: string,
  uid: number,
  pid: number
): string {
  const payload: AnonymousJwtClaims = {
    aud: Config.polisJwtAudience as string,
    iss: Config.polisJwtIssuer as string,
    pid,
    uid,
    sub: `anon:${uid}`,
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
    iat: Math.floor(Date.now() / 1000),
    conversation_id: conversationId,
    anonymous_participant: true,
  };

  try {
    const privateKey = _getPrivateKey();
    return jwt.sign(payload, privateKey, { algorithm: "RS256" });
  } catch (error) {
    logger.error("Failed to sign anonymous JWT:", error);
    throw new Error("Failed to create anonymous authentication token");
  }
}

// Validate anonymous JWT middleware
const anonymousJwtValidation = expressjwt({
  secret: () => {
    try {
      return _getPublicKey();
    } catch (error) {
      logger.error(
        "Failed to get public key for anonymous JWT validation:",
        error
      );
      throw error;
    }
  },
  audience: Config.polisJwtAudience as string,
  issuer: Config.polisJwtIssuer as string,
  algorithms: ["RS256"],
  requestProperty: "anonymousJwtPayload",
});

// Optional anonymous JWT validation
const anonymousJwtValidationOptional = expressjwt({
  secret: () => {
    try {
      return _getPublicKey();
    } catch (error) {
      logger.error(
        "Failed to get public key for optional anonymous JWT validation:",
        error
      );
      throw error;
    }
  },
  audience: Config.polisJwtAudience as string,
  issuer: Config.polisJwtIssuer as string,
  algorithms: ["RS256"],
  credentialsRequired: false,
  requestProperty: "anonymousJwtPayload",
});

// Extract user info from anonymous JWT
const extractUserFromAnonymousJWT = (
  assigner?: (req: any, key: string, value: any) => void
) => {
  return async (req: any, res: any, next: any) => {
    try {
      if (req.anonymousJwtPayload) {
        logger.debug("Anonymous JWT user info:", req.anonymousJwtPayload);

        const payload = req.anonymousJwtPayload as AnonymousJwtClaims;

        // Validate that this is actually an anonymous JWT
        if (
          !payload.anonymous_participant ||
          !payload.sub?.startsWith("anon:")
        ) {
          logger.error("Invalid anonymous JWT claims:", payload);
          return next(new Error("Invalid anonymous JWT format"));
        }

        // Check conversation scoping but don't error - just set flags
        const requestedConversationId =
          req.query?.conversation_id || req.body?.conversation_id;

        // Set up the request parameters using assigner function
        req.p = req.p || {};

        // Store anonymous-specific data that doesn't conflict with standard parameters
        req.p.pid = payload.pid;
        req.p.conversation_id = payload.conversation_id;
        req.p.anonymous_participant = payload.anonymous_participant;

        // Set conversation mismatch flag
        if (
          requestedConversationId &&
          payload.conversation_id !== requestedConversationId
        ) {
          req.p.jwt_conversation_mismatch = true;
          req.p.jwt_conversation_id = payload.conversation_id;
          req.p.requested_conversation_id = requestedConversationId;
          logger.debug(
            `Anonymous JWT conversation mismatch detected: token for ${payload.conversation_id}, request for ${requestedConversationId}`
          );
        } else {
          req.p.jwt_conversation_mismatch = false;
        }

        // Use the assigner function for standard parameters (canonical parameter middleware pattern)
        if (assigner) {
          assigner(req, "uid", payload.uid);
        }

        logger.debug(
          `Successfully extracted anonymous participant: uid: ${payload.uid}, conversation: ${payload.conversation_id}`
        );
      } else {
        logger.warn("No anonymous JWT payload found in request");
      }
      next();
    } catch (error) {
      logger.error("Error extracting user from anonymous JWT:", error);
      next(error);
    }
  };
};

// Verify an anonymous JWT manually
function _verifyAnonymousJWT(token: string): AnonymousJwtClaims {
  try {
    const publicKey = _getPublicKey();
    const payload = jwt.verify(token, publicKey, {
      audience: Config.polisJwtAudience as string,
      issuer: Config.polisJwtIssuer as string,
      algorithms: ["RS256"],
    }) as AnonymousJwtClaims;

    // Additional validation
    if (!payload.anonymous_participant || !payload.sub?.startsWith("anon:")) {
      throw new Error("Invalid anonymous JWT claims");
    }

    return payload;
  } catch (error) {
    logger.error("Anonymous JWT verification failed:", error);
    throw new Error("Invalid anonymous JWT");
  }
}

export {
  anonymousJwtValidation,
  anonymousJwtValidationOptional,
  extractUserFromAnonymousJWT,
  isAnonymousJWT,
  issueAnonymousJWT,
};
