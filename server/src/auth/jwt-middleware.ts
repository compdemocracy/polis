import { expressjwt } from "express-jwt";
import { GetVerificationKey, expressJwtSecret } from "jwks-rsa";
import os from "os";
import Config from "../config";
import logger from "../utils/logger";
import { getOrCreateUserIDFromOidcSub } from "./create-user";

// JWT validation middleware using OIDC
const jwtValidation = expressjwt({
  // Dynamically provide signing key based on the kid in the header and the signing keys provided by JWKS endpoint
  secret: expressJwtSecret({
    cache: true,
    rateLimit: Config.isDevMode ? false : true,
    jwksRequestsPerMinute: 5,
    jwksUri: Config.jwksUri as string,
    handleSigningKeyError: (err, cb) => {
      logger.error("JWKS Signing Key Error:", {
        message: err.message,
        code: (err as any).code,
        jwksUri: Config.jwksUri,
      });
      cb(err);
    },
  }) as GetVerificationKey,

  // Validate the audience and the issuer
  audience: Config.authAudience as string,
  issuer: Config.authIssuer as string,
  algorithms: ["RS256"],

  // Use a different property name to avoid conflict with legacy Express req.auth
  requestProperty: "jwtPayload",
});

// Optional JWT validation - doesn't fail if no token is present
const jwtValidationOptional = expressjwt({
  secret: expressJwtSecret({
    cache: true,
    rateLimit: Config.isDevMode ? false : true,
    jwksRequestsPerMinute: 5,
    jwksUri: Config.jwksUri as string,
    handleSigningKeyError: (err, cb) => {
      logger.error("JWKS Signing Key Error (Optional):", {
        message: err.message,
        code: (err as any).code,
        jwksUri: Config.jwksUri,
        hostname: os.hostname(),
        networkInterfaces: Object.keys(os.networkInterfaces()),
      });
      cb(err);
    },
  }) as GetVerificationKey,

  audience: Config.authAudience as string,
  issuer: Config.authIssuer as string,
  algorithms: ["RS256"],
  credentialsRequired: false,

  // Use a different property name to avoid conflict with legacy Express req.auth
  requestProperty: "jwtPayload",
});

// Middleware to extract user info from JWT and assign to request
const extractUserFromJWT = (
  assigner?: (req: any, key: string, value: any) => void
) => {
  return async (req: any, res: any, next: any) => {
    try {
      // The express-jwt middleware now adds the decoded token to req.jwtPayload instead of req.auth
      if (req.jwtPayload) {
        // Map OIDC sub to local user ID
        const oidcSub = req.jwtPayload.sub;

        try {
          const localUid = await getOrCreateUserIDFromOidcSub(
            oidcSub,
            req.jwtPayload
          );

          // Set up the request parameters for downstream handlers using assigner function
          req.p = req.p || {};

          // Store OIDC-specific data that doesn't conflict with standard parameters
          req.p.oidcUser = req.jwtPayload; // Keep the original OIDC user data
          req.p.oidcSub = oidcSub; // Keep the OIDC sub for reference
          req.p.emailVerified = req.jwtPayload.email_verified; // Store email verification status
          req.p.delphiEnabled =
            req.jwtPayload[`${Config.authNamespace}delphi_enabled`];

          // Use the assigner function for uid (canonical parameter middleware pattern)
          if (assigner) {
            assigner(req, "uid", localUid);
          }
        } catch (userCreationError: any) {
          logger.error("Error creating/mapping user from JWT:", {
            oidcSub: oidcSub,
            email: req.jwtPayload.email,
            error: userCreationError.message,
            errorCode: userCreationError.code,
            errorConstraint: userCreationError.constraint,
          });

          // Handle different types of errors more specifically
          if (userCreationError.message?.includes("high concurrency")) {
            // This is a race condition error after retries failed
            return res.status(429).json({
              error: "too_many_requests",
              message:
                "Authentication system is experiencing high load. Please try again in a moment.",
              retry_after: 1, // Suggest retry after 1 second
            });
          } else if (
            userCreationError.message?.includes("OIDC user missing email")
          ) {
            // Missing required user data
            return res.status(400).json({
              error: "invalid_user_data",
              message: "User account is missing required information (email).",
            });
          } else if (userCreationError.code === "23505") {
            // Database constraint violation - likely a race condition that wasn't handled
            logger.warn("Unhandled constraint violation in JWT middleware:", {
              oidcSub,
              constraint: userCreationError.constraint,
              error: userCreationError.message,
            });

            return res.status(429).json({
              error: "authentication_conflict",
              message:
                "Authentication system encountered a temporary conflict. Please try again.",
              retry_after: 1,
            });
          } else {
            // For other user creation errors, we want to return a 500 error rather than crash
            // This ensures the request is handled gracefully
            return res.status(500).json({
              error: "user_creation_failed",
              message: "Failed to create or map user account",
              // Don't expose internal details in production
              ...(Config.isDevMode && {
                details: userCreationError.message,
              }),
            });
          }
        }
      }
      next();
    } catch (error: any) {
      logger.error("Unexpected error in JWT middleware:", {
        error: error.message,
        stack: error.stack,
        oidcSub: req.jwtPayload?.sub,
      });

      // Catch-all for any other unexpected errors to prevent crashes
      return res.status(500).json({
        error: "authentication_error",
        message: "An unexpected authentication error occurred",
        ...(Config.isDevMode && {
          details: error.message,
        }),
      });
    }
  };
};

export { extractUserFromJWT, jwtValidation, jwtValidationOptional };
