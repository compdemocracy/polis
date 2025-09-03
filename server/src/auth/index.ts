/**
 * Consolidated authentication module for Polis
 *
 * This module provides a unified interface for authentication during the
 * transition from cookie-based auth to OIDC JWT authentication.
 *
 * Usage:
 * ```typescript
 * import { hybridAuth, hybridAuthOptional } from './hybrid-jwt';
 *
 * // For required authentication
 * app.get('/api/protected', hybridAuth(assignToP), handler);
 *
 * // For optional authentication
 * app.get('/api/public', hybridAuthOptional(assignToP), handler);
 * ```
 */

// Anonymous JWT functions
export {
  anonymousJwtValidation,
  anonymousJwtValidationOptional,
  extractUserFromAnonymousJWT,
  isAnonymousJWT,
  issueAnonymousJWT,
} from "./anonymous-jwt";

// Utility functions that are still needed
export { createXidEntry, deleteSuzinvite, xidExists } from "./auth";

// Create user utilities
export {
  createAnonUser,
  generateAndRegisterZinvite,
  getOrCreateUserIDFromOidcSub,
} from "./create-user";

// Generate token utilities
export {
  generateToken,
  generateTokenP,
  generateRandomCode,
  generateLoginCode,
} from "./generate-token";

// Hybrid JWT middleware
export { hybridAuth, hybridAuthOptional } from "./hybrid-jwt";

// Auth token attachment middleware
export {
  attachAuthToken,
  attachAuthTokenConditional,
  attachAuthTokenWithOptions,
} from "./attach-auth-token";

// JWT middleware (for direct use if needed)
export {
  extractUserFromJWT,
  jwtValidation,
  jwtValidationOptional,
} from "./jwt-middleware";

// JWT utilities (shared functionality)
export {
  getPrivateKey,
  getPublicKey,
  isParticipantJWT,
  issueParticipantJWT,
  verifyParticipantJWT,
  type AnonymousJwtClaims,
  type BaseParticipantJwtClaims,
  type ParticipantJwtClaims,
  type StandardUserJwtClaims,
  type XidJwtClaims,
} from "./jwt-utils";

// Auth-related routes
export {
  handle_POST_auth_deregister_jwt,
  handle_POST_joinWithInvite,
} from "./routes";

// Standard User JWT functions
export {
  extractUserFromStandardUserJWT,
  isStandardUserJWT,
  issueStandardUserJWT,
  standardUserJwtValidation,
  standardUserJwtValidationOptional,
  verifyStandardUserJWT,
} from "./standard-user-jwt";

// XID JWT functions
export {
  extractUserFromXidJWT,
  issueXidJWT,
  isXidJWT,
  verifyXidJWT,
  xidJwtValidation,
  xidJwtValidationOptional,
} from "./xid-jwt";

// Participant management middleware
export {
  ensureParticipant,
  ensureParticipantOptional,
} from "./ensure-participant";
