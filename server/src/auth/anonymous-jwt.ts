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

import Config from "../config";
import { expressjwt } from "express-jwt";
import jwt from "jsonwebtoken";
import fs from "fs";
import logger from "../utils/logger";

interface AnonymousJwtClaims {
  aud: string; // Audience
  exp: number; // Expiration time
  iat: number; // Issued at time
  iss: string; // Issuer
  pid: number; // Participant ID
  sub: string; // "anon:<uid>"
  uid: number; // Local user ID
  anonymous: boolean; // Anonymous flag (always true)
  conversation_id: string; // Conversation ID
  anonymous_participant: boolean; // Anonymous participant flag
}

// Use the same keys as XID JWT for consistency
function getPrivateKey(): string {
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

function getPublicKey(): string {
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
      (
        payload.anonymous_participant &&
        payload.sub?.startsWith("anon:") &&
        payload.anonymous === true &&
        !payload.xid
      ) // Ensure it's not an XID JWT
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
    aud: Config.authAudience as string,
    iss: Config.authIssuer as string,
    pid,
    uid,
    sub: `anon:${uid}`,
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
    iat: Math.floor(Date.now() / 1000),
    anonymous: true,
    conversation_id: conversationId,
    anonymous_participant: true,
  };

  try {
    const privateKey = getPrivateKey();
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
      return getPublicKey();
    } catch (error) {
      logger.error(
        "Failed to get public key for anonymous JWT validation:",
        error
      );
      throw error;
    }
  },
  audience: Config.authAudience as string,
  issuer: Config.authIssuer as string,
  algorithms: ["RS256"],
  requestProperty: "anonymousJwtPayload",
});

// Optional anonymous JWT validation
const anonymousJwtValidationOptional = expressjwt({
  secret: () => {
    try {
      return getPublicKey();
    } catch (error) {
      logger.error(
        "Failed to get public key for optional anonymous JWT validation:",
        error
      );
      throw error;
    }
  },
  audience: Config.authAudience as string,
  issuer: Config.authIssuer as string,
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

        // Validate conversation scoping: JWT's conversation_id must match requested conversation_id
        const requestedConversationId =
          req.query?.conversation_id || req.body?.conversation_id;
        if (
          requestedConversationId &&
          payload.conversation_id !== requestedConversationId
        ) {
          logger.warn(
            `Anonymous JWT conversation mismatch: token for ${payload.conversation_id}, request for ${requestedConversationId}`
          );
          return next(new Error("JWT not valid for this conversation"));
        }

        // Set up the request parameters
        req.p = req.p || {};
        req.p.uid = payload.uid;
        req.p.pid = payload.pid;
        req.p.conversation_id = payload.conversation_id;
        req.p.anonymous = payload.anonymous;
        req.p.anonymous_participant = payload.anonymous_participant;

        // Call the assigner function if provided
        if (assigner) {
          assigner(req, "uid", payload.uid);
        }

        logger.debug(
          `Successfully authenticated anonymous participant: uid: ${payload.uid}, pid: ${payload.pid}`
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
function verifyAnonymousJWT(token: string): AnonymousJwtClaims {
  try {
    const publicKey = getPublicKey();
    const payload = jwt.verify(token, publicKey, {
      audience: Config.authAudience as string,
      issuer: Config.authIssuer as string,
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
  issueAnonymousJWT,
  isAnonymousJWT,
  verifyAnonymousJWT,
  anonymousJwtValidation,
  anonymousJwtValidationOptional,
  extractUserFromAnonymousJWT,
};

export type { AnonymousJwtClaims };
