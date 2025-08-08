/**
 * Middleware for automatically attaching auth tokens to JSON responses
 *
 * This middleware intercepts res.json() calls and automatically adds the auth token
 * from req.p.authToken if it exists. This eliminates the need for route handlers
 * to manually include the token in their responses.
 *
 * IMPORTANT: This middleware should be placed AFTER ensureParticipant middleware
 * in the middleware chain, as ensureParticipant is responsible for creating
 * req.p.authToken when a new JWT needs to be issued.
 *
 * The middleware will only attach tokens to successful JSON responses (status 200/201)
 * and will not modify error responses or responses that already have an auth property.
 */

import { Response, NextFunction } from "express";
import { RequestWithP } from "../d";

/**
 * Middleware that automatically attaches auth tokens to JSON responses
 *
 * Usage:
 * - Apply this middleware AFTER ensureParticipant middleware
 * - It will automatically add { auth: { token, token_type, expires_in } } to JSON responses
 * - Only affects res.json() calls, not res.send(), res.end(), etc.
 *
 * @example
 * app.post('/api/v3/votes',
 *   hybridAuthOptional(assignToP),
 *   ensureParticipant({ createIfMissing: true, issueJWT: true }),
 *   attachAuthToken(),  // Add this after ensureParticipant
 *   handle_POST_votes
 * );
 */
export function attachAuthToken() {
  return function attachAuthTokenMiddleware(
    req: RequestWithP,
    res: Response,
    next: NextFunction
  ) {
    // Store the original res.json function
    const originalJson = res.json.bind(res);

    // Override res.json to inject auth token if present
    res.json = function (body: any) {
      // Check if we have an auth token to attach
      if (
        req.p?.authToken &&
        body &&
        typeof body === "object" &&
        !Array.isArray(body)
      ) {
        // Only add auth token if the response doesn't already have one
        if (!body.auth) {
          // Create a new object to avoid mutating the original
          body = {
            ...body,
            auth: req.p.authToken,
          };
        }
      }

      // Call the original res.json with the potentially modified body
      return originalJson(body);
    };

    next();
  };
}

/**
 * Conditional version that only attaches tokens for specific status codes
 *
 * @param statusCodes - Array of status codes to attach tokens for (default: [200, 201])
 */
export function attachAuthTokenConditional(statusCodes: number[] = [200, 201]) {
  return function attachAuthTokenConditionalMiddleware(
    req: RequestWithP,
    res: Response,
    next: NextFunction
  ) {
    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      // Only attach token for successful responses
      const currentStatus = res.statusCode;

      if (
        statusCodes.includes(currentStatus) &&
        req.p?.authToken &&
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        !body.auth
      ) {
        body = {
          ...body,
          auth: req.p.authToken,
        };
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * Version that can be configured to exclude certain response properties
 *
 * @param options - Configuration options
 */
export interface AttachAuthTokenOptions {
  /**
   * Only attach token for these status codes
   */
  statusCodes?: number[];

  /**
   * Don't attach token if response has any of these properties
   */
  excludeIfHasProperties?: string[];
}

export function attachAuthTokenWithOptions(
  options: AttachAuthTokenOptions = {}
) {
  const { statusCodes = [200, 201], excludeIfHasProperties = [] } = options;

  return function attachAuthTokenWithOptionsMiddleware(
    req: RequestWithP,
    res: Response,
    next: NextFunction
  ) {
    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      const currentStatus = res.statusCode;

      // Check all conditions for attaching token
      const shouldAttach =
        statusCodes.includes(currentStatus) &&
        req.p?.authToken &&
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        !body.auth &&
        !excludeIfHasProperties.some((prop) => prop in body);

      if (shouldAttach) {
        body = {
          ...body,
          auth: req.p.authToken,
        };
      }

      return originalJson(body);
    };

    next();
  };
}
