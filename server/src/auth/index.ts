/**
 * Consolidated authentication module for Polis
 *
 * This module provides a unified interface for authentication during the
 * transition from cookie-based auth to Auth0 JWT authentication.
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

// JWT middleware (for direct use if needed)
export {
  jwtValidation,
  jwtValidationOptional,
  extractUserFromJWT,
} from "./jwt-middleware";

// XID JWT functions
export {
  issueXidJWT,
  isXidJWT,
  verifyXidJWT,
  xidJwtValidation,
  xidJwtValidationOptional,
  extractUserFromXidJWT,
} from "./xid-jwt";

// Anonymous JWT functions
export {
  issueAnonymousJWT,
  isAnonymousJWT,
  verifyAnonymousJWT,
  anonymousJwtValidation,
  anonymousJwtValidationOptional,
  extractUserFromAnonymousJWT,
} from "./anonymous-jwt";

// Hybrid JWT middleware
export { hybridAuth, hybridAuthOptional } from "./hybrid-jwt";

// Auth-related routes
export {
  handle_POST_auth_deregister,
  handle_POST_auth_deregister_jwt,
  handle_POST_joinWithInvite,
} from "./routes";

// Utility functions that are still needed
export {
  getSUZinviteInfo,
  xidExists,
  createXidEntry,
  deleteSuzinvite,
} from "./auth";

// Types
export type AuthMiddleware = (
  req: any,
  res: any,
  next: any
) => void | Promise<void>;

export interface Auth0UserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nickname?: string;
  picture?: string;
  [key: string]: any;
}

// Re-export password utilities (still needed for password reset functionality)
import * as PasswordUtils from "./password";
export { PasswordUtils };
