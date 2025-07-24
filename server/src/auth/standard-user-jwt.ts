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
 * - 1-year expiration
 */

import {
  StandardUserJwtClaims,
  createExtractUserMiddleware,
  createJwtValidation,
  isParticipantJWT,
  issueParticipantJWT,
  verifyParticipantJWT,
} from "./jwt-utils";

// Check if a token is a standard user JWT
export function isStandardUserJWT(token: string): boolean {
  return isParticipantJWT(token, "standard_user");
}

// Issue a new standard user JWT
export function issueStandardUserJWT(
  oidcSub: string,
  conversationId: string,
  uid: number,
  pid: number
): string {
  return issueParticipantJWT(
    "standard_user",
    conversationId,
    uid,
    pid,
    oidcSub
  );
}

// Validate standard user JWT middleware
export const standardUserJwtValidation = createJwtValidation(
  "standardUserJwtPayload",
  true
);

// Optional standard user JWT validation
export const standardUserJwtValidationOptional = createJwtValidation(
  "standardUserJwtPayload",
  false
);

// Extract user info from standard user JWT
export const extractUserFromStandardUserJWT = (
  assigner?: (req: any, key: string, value: any) => void
) =>
  createExtractUserMiddleware(
    "standard_user",
    "standardUserJwtPayload",
    assigner
  );

// Verify a standard user JWT manually
export function verifyStandardUserJWT(token: string): StandardUserJwtClaims {
  return verifyParticipantJWT(token, "standard_user") as StandardUserJwtClaims;
}

// Re-export type for backward compatibility
export type { StandardUserJwtClaims };
