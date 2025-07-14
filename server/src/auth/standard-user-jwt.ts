/**
 * JWT implementation for standard users (OIDC-authenticated) participating in conversations
 *
 * This bridges OIDC authentication with Polis's conversation-scoped participant system.
 * Standard users get conversation-specific JWTs when they participate, maintaining
 * consistency with XID and anonymous participants.
 *
 * Key features:
 * - Links to existing OIDC identity via oidc_sub
 * - Conversation-scoped like other participant JWTs
 * - Maintains existing uid from oidc_user_mappings
 * - 24-hour expiration
 */

import { expressjwt } from "express-jwt";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import Config from "../config";
import logger from "../utils/logger";

interface StandardUserJwtClaims {
  aud: string; // Audience
  exp: number; // Expiration time
  iat: number; // Issued at time
  iss: string; // Issuer
  pid: number; // Participant ID
  sub: string; // "user:<oidc_sub>"
  uid: number; // Local user ID
  oidc_sub: string; // OIDC subject identifier
  conversation_id: string; // Conversation ID
  standard_user_participant: boolean; // Standard user participant flag
}

// Use the same keys as XID/Anonymous JWT for consistency
function _getPrivateKey(): string {
  const keyPath = Config.jwtPrivateKeyPath;

  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    logger.error("Failed to load private key for standard user JWT:", error);
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
    logger.error("Failed to load public key for standard user JWT:", error);
    const envKey = Config.jwtPublicKey;
    if (!envKey) {
      throw new Error(
        "JWT public key not found. Set JWT_PUBLIC_KEY_PATH or JWT_PUBLIC_KEY"
      );
    }
    return envKey.replace(/\\n/g, "\n");
  }
}

// Check if a token is a standard user JWT
function isStandardUserJWT(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      return false;
    }

    const payload = decoded.payload;

    // Standard user JWTs have specific claims
    return !!(
      payload.standard_user_participant &&
      payload.oidc_sub &&
      payload.sub?.startsWith("user:")
    );
  } catch (error) {
    logger.warn("Error checking if token is standard user JWT:", error);
    return false;
  }
}

// Issue a new standard user JWT
function issueStandardUserJWT(
  oidcSub: string,
  conversationId: string,
  uid: number,
  pid: number
): string {
  const payload: StandardUserJwtClaims = {
    aud: Config.polisJwtAudience as string,
    iss: Config.polisJwtIssuer as string,
    pid,
    uid,
    oidc_sub: oidcSub,
    sub: `user:${oidcSub}`,
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
    iat: Math.floor(Date.now() / 1000),
    conversation_id: conversationId,
    standard_user_participant: true,
  };

  try {
    const privateKey = _getPrivateKey();
    return jwt.sign(payload, privateKey, { algorithm: "RS256" });
  } catch (error) {
    logger.error("Failed to sign standard user JWT:", error);
    throw new Error("Failed to create standard user authentication token");
  }
}

// Validate standard user JWT middleware
const standardUserJwtValidation = expressjwt({
  secret: () => {
    try {
      return _getPublicKey();
    } catch (error) {
      logger.error(
        "Failed to get public key for standard user JWT validation:",
        error
      );
      throw error;
    }
  },
  audience: Config.polisJwtAudience as string,
  issuer: Config.polisJwtIssuer as string,
  algorithms: ["RS256"],
  requestProperty: "standardUserJwtPayload",
});

// Optional standard user JWT validation
const standardUserJwtValidationOptional = expressjwt({
  secret: () => {
    try {
      return _getPublicKey();
    } catch (error) {
      logger.error(
        "Failed to get public key for optional standard user JWT validation:",
        error
      );
      throw error;
    }
  },
  audience: Config.polisJwtAudience as string,
  issuer: Config.polisJwtIssuer as string,
  algorithms: ["RS256"],
  credentialsRequired: false,
  requestProperty: "standardUserJwtPayload",
});

// Extract user info from standard user JWT
const extractUserFromStandardUserJWT = (
  assigner?: (req: any, key: string, value: any) => void
) => {
  return async (req: any, res: any, next: any) => {
    try {
      if (req.standardUserJwtPayload) {
        logger.debug(
          "Standard user JWT user info:",
          req.standardUserJwtPayload
        );

        const payload = req.standardUserJwtPayload as StandardUserJwtClaims;

        // Validate that this is actually a standard user JWT
        if (
          !payload.standard_user_participant ||
          !payload.oidc_sub ||
          !payload.sub?.startsWith("user:")
        ) {
          logger.error("Invalid standard user JWT claims:", payload);
          return next(new Error("Invalid standard user JWT format"));
        }

        // Check conversation scoping but don't error - just set flags
        const requestedConversationId =
          req.query?.conversation_id || req.body?.conversation_id;

        // Set up the request parameters using assigner function
        req.p = req.p || {};

        // Store standard user-specific data that doesn't conflict with standard parameters
        req.p.pid = payload.pid;
        req.p.oidc_sub = payload.oidc_sub;
        req.p.conversation_id = payload.conversation_id;
        req.p.standard_user_participant = payload.standard_user_participant;

        // Set conversation mismatch flag
        if (
          requestedConversationId &&
          payload.conversation_id !== requestedConversationId
        ) {
          req.p.jwt_conversation_mismatch = true;
          req.p.jwt_conversation_id = payload.conversation_id;
          req.p.requested_conversation_id = requestedConversationId;
          logger.debug(
            `Standard user JWT conversation mismatch detected: token for ${payload.conversation_id}, request for ${requestedConversationId}`
          );
        } else {
          req.p.jwt_conversation_mismatch = false;
        }

        // Use the assigner function for standard parameters (canonical parameter middleware pattern)
        if (assigner) {
          assigner(req, "uid", payload.uid);
        }

        logger.debug(
          `Successfully extracted standard user participant: uid: ${payload.uid}, oidc_sub: ${payload.oidc_sub}`
        );
      } else {
        logger.warn("No standard user JWT payload found in request");
      }
      next();
    } catch (error) {
      logger.error("Error extracting user from standard user JWT:", error);
      next(error);
    }
  };
};

// Verify a standard user JWT manually
function verifyStandardUserJWT(token: string): StandardUserJwtClaims {
  try {
    const publicKey = _getPublicKey();
    const payload = jwt.verify(token, publicKey, {
      audience: Config.polisJwtAudience as string,
      issuer: Config.polisJwtIssuer as string,
      algorithms: ["RS256"],
    }) as StandardUserJwtClaims;

    // Additional validation
    if (
      !payload.standard_user_participant ||
      !payload.oidc_sub ||
      !payload.sub?.startsWith("user:")
    ) {
      throw new Error("Invalid standard user JWT claims");
    }

    return payload;
  } catch (error) {
    logger.error("Standard user JWT verification failed:", error);
    throw new Error("Invalid standard user JWT");
  }
}

export {
  issueStandardUserJWT,
  isStandardUserJWT,
  verifyStandardUserJWT,
  standardUserJwtValidation,
  standardUserJwtValidationOptional,
  extractUserFromStandardUserJWT,
};
