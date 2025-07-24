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
 * - 1-year expiration
 * - No refresh mechanism
 */

import {
  AnonymousJwtClaims,
  createExtractUserMiddleware,
  createJwtValidation,
  isParticipantJWT,
  issueParticipantJWT,
} from "./jwt-utils";

// Check if a token is an anonymous JWT
export function isAnonymousJWT(token: string): boolean {
  return isParticipantJWT(token, "anonymous");
}

// Issue a new anonymous JWT
export function issueAnonymousJWT(
  conversationId: string,
  uid: number,
  pid: number
): string {
  return issueParticipantJWT("anonymous", conversationId, uid, pid);
}

// Validate anonymous JWT middleware
export const anonymousJwtValidation = createJwtValidation(
  "anonymousJwtPayload",
  true
);

// Optional anonymous JWT validation
export const anonymousJwtValidationOptional = createJwtValidation(
  "anonymousJwtPayload",
  false
);

// Extract user info from anonymous JWT
export const extractUserFromAnonymousJWT = (
  assigner?: (req: any, key: string, value: any) => void
) => createExtractUserMiddleware("anonymous", "anonymousJwtPayload", assigner);

// Re-export type for backward compatibility
export type { AnonymousJwtClaims };
