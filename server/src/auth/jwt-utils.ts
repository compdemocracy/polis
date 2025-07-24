/**
 * Shared JWT utilities for all participant types
 *
 * This module consolidates common JWT functionality to avoid duplication
 * across anonymous, XID, and standard user JWT implementations.
 */

import { expressjwt } from "express-jwt";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import Config from "../config";
import logger from "../utils/logger";

// Common JWT configuration
const JWT_ALGORITHM = "RS256";
const JWT_EXPIRATION_SECONDS = 365 * 24 * 60 * 60; // 1 year

// Base interface for all participant JWT claims
export interface BaseParticipantJwtClaims {
  aud: string; // Audience
  exp: number; // Expiration time
  iat: number; // Issued at time
  iss: string; // Issuer
  pid: number; // Participant ID
  sub: string; // Subject identifier
  uid: number; // Local user ID
  conversation_id: string; // Conversation ID
}

// Specific claim types for each participant type
export interface AnonymousJwtClaims extends BaseParticipantJwtClaims {
  anonymous_participant: boolean;
}

export interface XidJwtClaims extends BaseParticipantJwtClaims {
  xid: string;
  xid_participant: boolean;
}

export interface StandardUserJwtClaims extends BaseParticipantJwtClaims {
  oidc_sub: string;
  standard_user_participant: boolean;
}

export type ParticipantJwtClaims =
  | AnonymousJwtClaims
  | XidJwtClaims
  | StandardUserJwtClaims;

/**
 * Get private key for JWT signing
 * Prioritizes environment variable over file path
 */
export function getPrivateKey(): string {
  const envKey = Config.jwtPrivateKey;
  if (envKey) {
    // Try to detect if it's base64 (no PEM header)
    if (!envKey.includes("BEGIN")) {
      // Decode base64 to PEM
      return Buffer.from(envKey, "base64").toString("utf8");
    }
    return envKey.replace(/\\n/g, "\n");
  }

  const keyPath = Config.jwtPrivateKeyPath;
  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    logger.error("Failed to load JWT private key:", error);
    throw new Error(
      "JWT private key not found. Set JWT_PRIVATE_KEY or JWT_PRIVATE_KEY_PATH"
    );
  }
}

/**
 * Get public key for JWT verification
 * Prioritizes environment variable over file path
 */
export function getPublicKey(): string {
  const envKey = Config.jwtPublicKey;
  if (envKey) {
    // Try to detect if it's base64 (no PEM header)
    if (!envKey.includes("BEGIN")) {
      // Decode base64 to PEM
      return Buffer.from(envKey, "base64").toString("utf8");
    }
    return envKey.replace(/\\n/g, "\n");
  }

  const keyPath = Config.jwtPublicKeyPath;
  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    logger.error("Failed to load JWT public key:", error);
    throw new Error(
      "JWT public key not found. Set JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH"
    );
  }
}

/**
 * Check if a token is a participant JWT by examining its structure
 */
export function isParticipantJWT(
  token: string,
  participantType: "anonymous" | "xid" | "standard_user"
): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      return false;
    }

    const payload = decoded.payload;

    switch (participantType) {
      case "anonymous":
        return !!(payload.anonymous_participant && !payload.xid);
      case "xid":
        return !!(payload.xid_participant && payload.xid);
      case "standard_user":
        return !!(payload.standard_user_participant && payload.oidc_sub);
      default:
        return false;
    }
  } catch (error) {
    logger.warn(`Error checking if token is ${participantType} JWT:`, error);
    return false;
  }
}

/**
 * Issue a participant JWT
 */
export function issueParticipantJWT(
  participantType: "anonymous",
  conversationId: string,
  uid: number,
  pid: number
): string;
export function issueParticipantJWT(
  participantType: "xid",
  conversationId: string,
  uid: number,
  pid: number,
  xid: string
): string;
export function issueParticipantJWT(
  participantType: "standard_user",
  conversationId: string,
  uid: number,
  pid: number,
  oidcSub: string
): string;
export function issueParticipantJWT(
  participantType: "anonymous" | "xid" | "standard_user",
  conversationId: string,
  uid: number,
  pid: number,
  identifier?: string
): string {
  const basePayload = {
    aud: Config.polisJwtAudience as string,
    iss: Config.polisJwtIssuer as string,
    pid,
    uid,
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRATION_SECONDS,
    iat: Math.floor(Date.now() / 1000),
    conversation_id: conversationId,
  };

  let payload: ParticipantJwtClaims;

  switch (participantType) {
    case "anonymous":
      payload = {
        ...basePayload,
        sub: `anon:${uid}`,
        anonymous_participant: true,
      } as AnonymousJwtClaims;
      break;

    case "xid":
      if (!identifier) throw new Error("XID is required for XID JWT");
      payload = {
        ...basePayload,
        sub: `xid:${identifier}`,
        xid: identifier,
        xid_participant: true,
      } as XidJwtClaims;
      break;

    case "standard_user":
      if (!identifier)
        throw new Error("OIDC sub is required for standard user JWT");
      payload = {
        ...basePayload,
        sub: `user:${identifier}`,
        oidc_sub: identifier,
        standard_user_participant: true,
      } as StandardUserJwtClaims;
      break;

    default:
      throw new Error(`Unknown participant type: ${participantType}`);
  }

  try {
    const privateKey = getPrivateKey();
    return jwt.sign(payload, privateKey, { algorithm: JWT_ALGORITHM });
  } catch (error) {
    logger.error(`Failed to sign ${participantType} JWT:`, error);
    throw new Error(`Failed to create ${participantType} authentication token`);
  }
}

/**
 * Create JWT validation middleware
 */
export function createJwtValidation(
  requestProperty: string,
  credentialsRequired = true
) {
  return expressjwt({
    secret: () => {
      try {
        return getPublicKey();
      } catch (error) {
        logger.error("Failed to get public key for JWT validation:", error);
        throw error;
      }
    },
    audience: Config.polisJwtAudience as string,
    issuer: Config.polisJwtIssuer as string,
    algorithms: [JWT_ALGORITHM],
    credentialsRequired,
    requestProperty,
  });
}

/**
 * Extract user info from participant JWT
 */
export function createExtractUserMiddleware(
  participantType: "anonymous" | "xid" | "standard_user",
  payloadProperty: string,
  assigner?: (req: any, key: string, value: any) => void
) {
  return async (req: any, res: any, next: any) => {
    try {
      const payload = req[payloadProperty];

      if (!payload) {
        logger.warn(`No ${participantType} JWT payload found in request`);
        return next();
      }

      logger.debug(`${participantType} JWT user info:`, payload);

      // Validate participant type
      let isValid = false;
      switch (participantType) {
        case "anonymous":
          isValid = !!(
            payload.anonymous_participant && payload.sub?.startsWith("anon:")
          );
          break;
        case "xid":
          isValid = !!(
            payload.xid_participant &&
            payload.xid &&
            payload.sub?.startsWith("xid:")
          );
          break;
        case "standard_user":
          isValid = !!(
            payload.standard_user_participant &&
            payload.oidc_sub &&
            payload.sub?.startsWith("user:")
          );
          break;
      }

      if (!isValid) {
        logger.error(`Invalid ${participantType} JWT claims:`, payload);
        return next(new Error(`Invalid ${participantType} JWT format`));
      }

      // Check conversation scoping
      const requestedConversationId =
        req.query?.conversation_id || req.body?.conversation_id;

      // Set up request parameters
      req.p = req.p || {};
      req.p.pid = payload.pid;
      req.p.conversation_id = payload.conversation_id;
      req.p[`${participantType}_participant`] = true;

      // Add type-specific data
      if (participantType === "xid" && payload.xid) {
        req.p.xid = payload.xid;
      } else if (participantType === "standard_user" && payload.oidc_sub) {
        req.p.oidc_sub = payload.oidc_sub;
      }

      // Set conversation mismatch flag
      if (
        requestedConversationId &&
        payload.conversation_id !== requestedConversationId
      ) {
        req.p.jwt_conversation_mismatch = true;
        req.p.jwt_conversation_id = payload.conversation_id;
        req.p.requested_conversation_id = requestedConversationId;
        logger.debug(
          `${participantType} JWT conversation mismatch detected: token for ${payload.conversation_id}, request for ${requestedConversationId}`
        );
      } else {
        req.p.jwt_conversation_mismatch = false;
      }

      // Use assigner for standard parameters
      if (assigner) {
        assigner(req, "uid", payload.uid);
        if (participantType === "xid" && payload.xid) {
          assigner(req, "xid", payload.xid);
        }
      }

      logger.debug(
        `Successfully extracted ${participantType} participant: uid: ${payload.uid}, conversation: ${payload.conversation_id}`
      );

      next();
    } catch (error) {
      logger.error(`Error extracting user from ${participantType} JWT:`, error);
      next(error);
    }
  };
}

/**
 * Verify a participant JWT manually
 */
export function verifyParticipantJWT(
  token: string,
  participantType: "anonymous" | "xid" | "standard_user"
): ParticipantJwtClaims {
  try {
    const publicKey = getPublicKey();
    const payload = jwt.verify(token, publicKey, {
      audience: Config.polisJwtAudience as string,
      issuer: Config.polisJwtIssuer as string,
      algorithms: [JWT_ALGORITHM],
    }) as ParticipantJwtClaims;

    // Additional validation based on type
    let isValid = false;
    switch (participantType) {
      case "anonymous":
        isValid = !!(
          (payload as AnonymousJwtClaims).anonymous_participant &&
          payload.sub?.startsWith("anon:")
        );
        break;
      case "xid":
        isValid = !!(
          (payload as XidJwtClaims).xid_participant &&
          (payload as XidJwtClaims).xid &&
          payload.sub?.startsWith("xid:")
        );
        break;
      case "standard_user":
        isValid = !!(
          (payload as StandardUserJwtClaims).standard_user_participant &&
          (payload as StandardUserJwtClaims).oidc_sub &&
          payload.sub?.startsWith("user:")
        );
        break;
    }

    if (!isValid) {
      throw new Error(`Invalid ${participantType} JWT claims`);
    }

    return payload;
  } catch (error) {
    logger.error(`${participantType} JWT verification failed:`, error);
    throw new Error(`Invalid ${participantType} JWT`);
  }
}
