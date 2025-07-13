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
function _isAuth0JWT(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      return false;
    }

    const payload = decoded.payload;

    // Standard user JWTs have specific claims
    const isAuth0 = !!(
      payload.aud === Config.authAudience && payload.iss === Config.authIssuer
    );
    return isAuth0;
  } catch (error) {
    logger.warn("Error checking if token is Auth0 JWT:", error);
    return false;
  }
}

/**
 * Hybrid JWT validation middleware that supports Auth0, XID, Anonymous, and Standard User JWTs
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
      } else if (_isAuth0JWT(token)) {
        logger.debug("Detected Auth0 JWT, using Auth0 validation");

        // Use Auth0 JWT validation
        const auth0Validator = isOptional
          ? jwtValidationOptional
          : jwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          auth0Validator(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromJWT(assigner)(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        logger.debug("Auth0 JWT validation successful");
        return next();
      } else {
        logger.debug("No JWT token found, authentication required");
        return res.status(401).json({
          error: "No authentication token found",
        });
      }
    } catch (error) {
      logger.error("JWT validation failed:", error);

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
