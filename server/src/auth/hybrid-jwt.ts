import { NextFunction, Request, Response } from "express";
import Config from "../config";
import jwt from "jsonwebtoken";
import logger from "../utils/logger";
import {
  isAnonymousJWT,
  anonymousJwtValidation,
  anonymousJwtValidationOptional,
  extractUserFromAnonymousJWT,
} from "./anonymous-jwt";
import {
  jwtValidation,
  jwtValidationOptional,
  extractUserFromJWT,
} from "./jwt-middleware";
import {
  isStandardUserJWT,
  standardUserJwtValidation,
  standardUserJwtValidationOptional,
  extractUserFromStandardUserJWT,
} from "./standard-user-jwt";
import {
  isXidJWT,
  xidJwtValidation,
  xidJwtValidationOptional,
  extractUserFromXidJWT,
} from "./xid-jwt";

// Check if a token is a standard user JWT
function _isOidcJWT(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      logger.warn("_isOidcJWT: Token decode failed", {
        hasDecoded: !!decoded,
        hasPayload: !!decoded?.payload,
      });
      return false;
    }

    const payload = decoded.payload;

    // Handle audience as either string or array (JWT spec allows both)
    let audMatch = false;
    if (typeof payload.aud === "string") {
      audMatch = payload.aud === Config.authAudience;
    } else if (Array.isArray(payload.aud)) {
      audMatch = payload.aud.includes(Config.authAudience);
    }

    // Standard user JWTs have specific claims
    const issMatch = payload.iss === Config.authIssuer;
    const isOidc = !!(audMatch && issMatch);

    return isOidc;
  } catch (error) {
    logger.warn("Error checking if token is OIDC JWT:", error);
    return false;
  }
}

/**
 * Hybrid JWT validation middleware that supports OIDC, XID, Anonymous, and Standard User JWTs
 * This allows the same endpoints to work with all authentication methods
 */
function _createHybridJwtMiddleware(
  assigner?: (req: any, key: string, value: any) => void,
  isOptional = false
) {
  return async function hybridJwtMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const authHeader = req.headers.authorization;

    // If we have no Bearer token, and auth is optional, just continue.
    // If auth is required, send a 401. Let's handle this first.
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (isOptional) {
        logger.debug("No JWT token found, continuing without authentication");
        return next();
      } else {
        logger.debug("No JWT token found, authentication required");
        return res.status(401).json({
          error: "No authentication token found",
        });
      }
    }

    // We have a Bearer token, so let's validate it.
    const token = authHeader.substring(7);

    try {
      // Determine which validation to use based on token type
      if (isXidJWT(token)) {
        logger.debug("Detected XID JWT, using XID validation");

        // Use XID JWT validation
        const xidValidator = isOptional
          ? xidJwtValidationOptional
          : xidJwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          xidValidator(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromXidJWT(assigner)(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        logger.debug("XID JWT validation successful");
        return next();
      } else if (isAnonymousJWT(token)) {
        logger.debug("Detected Anonymous JWT, using anonymous validation");

        // Use Anonymous JWT validation
        const anonValidator = isOptional
          ? anonymousJwtValidationOptional
          : anonymousJwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          anonValidator(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromAnonymousJWT(assigner)(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        logger.debug("Anonymous JWT validation successful");
        return next();
      } else if (isStandardUserJWT(token)) {
        logger.debug(
          "Detected Standard User JWT, using standard user validation"
        );

        // Use Standard User JWT validation
        const standardUserValidator = isOptional
          ? standardUserJwtValidationOptional
          : standardUserJwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          standardUserValidator(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromStandardUserJWT(assigner)(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        logger.debug("Standard User JWT validation successful");
        return next();
      } else if (_isOidcJWT(token)) {
        logger.debug("Detected OIDC JWT, using OIDC validation");

        // Use OIDC JWT validation
        const oidcValidator = isOptional
          ? jwtValidationOptional
          : jwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          oidcValidator(req, res, (err?: any) => {
            if (err) {
              logger.error("OIDC JWT validation failed", {
                error: err.message,
                code: err.code,
                name: err.name,
                inner: err.inner,
              });
              reject(err);
            } else {
              resolve();
            }
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromJWT(assigner)(req, res, (err?: any) => {
            if (err) {
              logger.error("OIDC JWT user extraction failed", {
                error: err.message,
              });
              reject(err);
            } else {
              resolve();
            }
          });
        });

        logger.debug("OIDC JWT validation successful");
        return next();
      } else {
        logger.warn("Token does not match any known JWT type", {
          tokenSample: token.substring(0, 50) + "...",
        });

        return res.status(401).json({
          error: "Invalid token format",
          details: "Token does not match any supported JWT type",
        });
      }
    } catch (error) {
      logger.error("JWT validation failed", {
        message: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
      });

      // If a token was provided but is invalid, always return 401
      // "Optional" auth only applies to missing tokens, not invalid ones
      return res.status(401).json({
        error: "Invalid authentication token",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}

/**
 * Required hybrid JWT authentication
 */
const hybridAuth = (assigner?: (req: any, key: string, value: any) => void) =>
  _createHybridJwtMiddleware(assigner, false);

/**
 * Optional hybrid JWT authentication
 */
const hybridAuthOptional = (
  assigner?: (req: any, key: string, value: any) => void
) => _createHybridJwtMiddleware(assigner, true);

export { hybridAuth, hybridAuthOptional };
