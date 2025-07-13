import { expressjwt } from "express-jwt";
import { GetVerificationKey, expressJwtSecret } from "jwks-rsa";
import os from "os";
import Config from "../config";
import logger from "../utils/logger";
import { getOrCreateUserIDFromAuth0Sub } from "./create-user";

// JWT validation middleware using Auth0
const jwtValidation = expressjwt({
  // Dynamically provide signing key based on the kid in the header and the signing keys provided by JWKS endpoint
  secret: expressJwtSecret({
    cache: true,
    rateLimit: true,
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
    rateLimit: true,
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
        // Map Auth0 sub to local user ID
        const auth0Sub = req.jwtPayload.sub;

        try {
          const localUid = await getOrCreateUserIDFromAuth0Sub(
            auth0Sub,
            req.jwtPayload
          );

          // Set up the request parameters for downstream handlers
          req.p = req.p || {};
          req.p.auth0User = req.jwtPayload; // Keep the original Auth0 user data
          req.p.auth0Sub = auth0Sub; // Keep the Auth0 sub for reference
          req.p.emailVerified = req.jwtPayload.email_verified; // Store email verification status
          req.p.uid = localUid; // Store the local user ID

          // Call the assigner function if provided (for compatibility with parameter middleware)
          if (assigner) {
            assigner(req, "uid", localUid);
          }
        } catch (userCreationError: any) {
          logger.error("Error creating/mapping user from JWT:", {
            auth0Sub: auth0Sub,
            email: req.jwtPayload.email,
            error: userCreationError.message,
          });

          // For user creation errors, we want to return a 500 error rather than crash
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
      next();
    } catch (error) {
      logger.error("Error extracting user from JWT:", error);

      // Return a proper error response instead of just calling next(error)
      // which might cause the server to crash in some configurations
      return res.status(500).json({
        error: "jwt_processing_failed",
        message: "Failed to process JWT token",
        ...(Config.isDevMode && {
          details: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  };
};

export { extractUserFromJWT, jwtValidation, jwtValidationOptional };
