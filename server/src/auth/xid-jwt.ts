/**
 * Custom JWT implementation for XID users
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
 * - Tokens are long-lived (1 year)
 * - Tokens are scoped to specific conversations
 * - No refresh mechanism (participants must re-initialize)
 */

import {
  XidJwtClaims,
  createExtractUserMiddleware,
  createJwtValidation,
  isParticipantJWT,
  issueParticipantJWT,
  verifyParticipantJWT,
} from "./jwt-utils";

// Check if a token is an XID JWT by examining its structure
export function isXidJWT(token: string): boolean {
  return isParticipantJWT(token, "xid");
}

// Issue a new XID JWT
export function issueXidJWT(
  xid: string,
  conversationId: string,
  uid: number,
  pid: number
): string {
  return issueParticipantJWT("xid", conversationId, uid, pid, xid);
}

// Validate XID JWT middleware
export const xidJwtValidation = createJwtValidation("xidJwtPayload", true);

// Optional XID JWT validation - doesn't fail if no token is present
export const xidJwtValidationOptional = createJwtValidation(
  "xidJwtPayload",
  false
);

// Extract XID user info from JWT and assign to request
export const extractUserFromXidJWT = (
  assigner?: (req: any, key: string, value: any) => void
) => createExtractUserMiddleware("xid", "xidJwtPayload", assigner);

// Verify an XID JWT manually (for custom validation scenarios)
export function verifyXidJWT(token: string): XidJwtClaims {
  return verifyParticipantJWT(token, "xid") as XidJwtClaims;
}

// Re-export type for backward compatibility
export type { XidJwtClaims };
