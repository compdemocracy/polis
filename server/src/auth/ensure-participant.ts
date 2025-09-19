/**
 * Middleware for ensuring a participant exists for the current request
 *
 * This middleware handles the complete flow of participant identification and creation:
 * 1. Handles JWT conversation mismatches
 * 2. Checks legacy cookies
 * 3. Creates anonymous users if needed
 * 4. Gets or creates participant records
 * 5. Issues JWTs for new participants
 *
 * This consolidates logic that was previously duplicated across multiple routes
 * (votes, comments, etc.) into a single reusable middleware.
 */

import _ from "underscore";
import { addParticipantAndMetadata } from "../participant";
import { checkLegacyCookieAndIssueJWT } from "./legacyCookies";
import { createAnonUser } from "./create-user";
import { getPidPromise } from "../user";
import { getZinvite } from "../utils/zinvite";
import { isDuplicateKey } from "../utils/common";
import { issueAnonymousJWT } from "./anonymous-jwt";
import { issueStandardUserJWT } from "./standard-user-jwt";
import { issueXidJWT } from "./xid-jwt";
import { RequestWithP } from "../d";
import { Response, NextFunction } from "express";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import { failJson } from "../utils/fail";
import {
  createXidRecordByZid,
  getConversationInfo,
  getXidRecord,
  isXidWhitelisted,
  getZidFromConversationId,
} from "../conversation";

// Validation function for conversation_id (same as in parameter.ts)
function validateConversationId(conversation_id: string): string {
  if (!conversation_id || typeof conversation_id !== "string") {
    throw new Error("polis_fail_parse_string");
  }
  if (conversation_id.length < 1 || conversation_id.length > 100) {
    throw new Error("polis_fail_parse_string_length");
  }
  return conversation_id;
}

interface ParticipantCreationResult {
  uid: number | undefined;
  pid: number | undefined;
  isNewlyCreatedUser: boolean;
  isNewlyCreatedParticipant: boolean;
  needsNewJWT: boolean;
  token?: string;
  conversationId?: string;
}

interface EnsureParticipantOptions {
  /**
   * Whether to create a new participant if one doesn't exist
   * Default: true
   */
  createIfMissing?: boolean;

  /**
   * Whether to issue a JWT for newly created participants
   * Default: true
   */
  issueJWT?: boolean;

  /**
   * Property name to store the participant info in req.p
   * Default: uses existing properties (uid, pid, etc.)
   */
  resultProperty?: string;

  /**
   * Custom assigner function for setting values on the request
   */
  assigner?: (req: RequestWithP, key: string, value: unknown) => void;
}

/**
 * Handle JWT conversation mismatches
 * Returns true if the request should be treated as a new participant
 */
async function _handleJWTConversationMismatch(
  req: RequestWithP,
  zid: number
): Promise<boolean> {
  if (!req.p.jwt_conversation_mismatch) {
    return false;
  }

  if (req.p.anonymous_participant) {
    // Anonymous participant with JWT for different conversation - treat as new
    logger.debug(
      "Anonymous participant with JWT for different conversation - treating as new"
    );
    req.p.uid = undefined;
    req.p.pid = undefined;
    return true;
  }

  if (req.p.xid_participant && req.p.xid) {
    // XID participant - apply the 4-case logic
    const jwtXid = req.p.jwt_xid;
    const requestXid = req.p.xid;
    const xidMatches = jwtXid === requestXid;

    // Check if XID exists for current conversation
    let xidForCurrentConversation = false;
    try {
      const xidRecords = await getXidRecord(requestXid, zid);
      if (xidRecords && xidRecords.length > 0) {
        xidForCurrentConversation = true;
      }
    } catch (err) {
      // XID not found for this conversation
    }

    if (xidMatches) {
      // Case 2: Token and XID align but are for different conversation
      logger.debug(
        "Case 2: XID participant with matching JWT/XID for different conversation - treating as anonymous"
      );
      req.p.xid = undefined; // Clear XID to treat as anonymous
      req.p.uid = undefined;
      req.p.pid = undefined;
      return true;
    } else if (!xidMatches && xidForCurrentConversation) {
      // Case 3: Token for different conversation, but XID is for current
      logger.debug(
        "Case 3: XID participant with mismatched JWT but XID for current conversation - maintaining XID"
      );
      req.p.uid = undefined;
      req.p.pid = undefined;
      return true;
    } else {
      // Case 4: Token for current conversation, but XID for different
      logger.debug(
        "Case 4: XID participant with JWT for current conversation but XID for different - treating as anonymous"
      );
      req.p.xid = undefined; // Clear XID
      // Keep uid/pid from JWT
      return false;
    }
  }

  if (req.p.standard_user_participant) {
    // Standard user participants should maintain their identity
    // but get a new participant record for the new conversation
    req.p.pid = undefined;
    return true;
  }

  return false;
}

/**
 * Handle user identification and creation
 */
async function _handleUserIdentification(
  req: RequestWithP,
  zid: number
): Promise<number> {
  const uid = req.p.uid;

  if (uid !== undefined) {
    return uid;
  }

  if (req.p.xid) {
    // Handle XID users - look up or create their UID
    const existingXidRecords = await getXidRecord(req.p.xid, zid);

    if (existingXidRecords && existingXidRecords.length > 0) {
      // XID user already exists
      return existingXidRecords[0].uid;
    }

    // XID user doesn't exist, need to create one
    const conv = await getConversationInfo(zid);
    if (conv.use_xid_whitelist) {
      const isWhitelisted = await isXidWhitelisted(conv.owner, req.p.xid);
      if (!isWhitelisted) {
        throw new Error("polis_err_xid_not_whitelisted");
      }
    }

    // Create new anonymous user for this XID
    const newUid = await createAnonUser();

    // Create XID record linking the XID to the new user
    await createXidRecordByZid(
      zid,
      newUid,
      req.p.xid,
      undefined,
      undefined,
      undefined
    );

    return newUid;
  }

  // Create anonymous user
  const newUid = await createAnonUser();
  req.p.uid = newUid; // Set uid in request for subsequent middleware
  return newUid;
}

/**
 * Get or create participant for the given user and conversation
 */
async function _getOrCreateParticipant(
  zid: number,
  uid: number,
  existingPid: number | undefined,
  req: RequestWithP
): Promise<{ pid: number; isNewlyCreated: boolean }> {
  if (existingPid !== undefined && existingPid >= 0) {
    return { pid: existingPid, isNewlyCreated: false };
  }

  // Check if participant already exists
  const foundPid = await getPidPromise(zid, uid, true);

  if (foundPid !== -1) {
    return { pid: foundPid, isNewlyCreated: false };
  }

  // Create new participant with constraint violation protection
  try {
    const rows = await addParticipantAndMetadata(zid, uid, req);
    return { pid: rows[0].pid, isNewlyCreated: true };
  } catch (createError) {
    // Handle race condition where another request created the participant
    if (isDuplicateKey(createError)) {
      const retryPid = await getPidPromise(zid, uid, true);
      if (retryPid !== -1) {
        return { pid: retryPid, isNewlyCreated: false };
      }
    }
    throw createError;
  }
}

/**
 * Issue JWT token for the participant if needed
 */
async function _issueJWTIfNeeded(
  req: RequestWithP,
  uid: number,
  pid: number,
  zid: number,
  isNewlyCreated: boolean,
  needsNewJWT: boolean,
  legacyCookieToken?: string
): Promise<{ token?: string; conversationId?: string }> {
  // Only issue JWT for:
  // 1. Newly created participants
  // 2. Participants that need a new JWT (conversation mismatch)
  // 3. Legacy cookie users who need migration
  // 4. XID participants who don't have a JWT yet (first authenticated action)
  // AND when they don't already have a valid JWT
  const isXidWithoutJWT =
    req.p.xid && !req.headers?.authorization && !legacyCookieToken;
  const shouldIssueJWT =
    (isNewlyCreated || needsNewJWT || isXidWithoutJWT) &&
    (!req.headers?.authorization || req.p.jwt_conversation_mismatch);

  if (!shouldIssueJWT) {
    logger.debug("JWT not needed", {
      isNewlyCreated,
      needsNewJWT,
      isXidWithoutJWT,
      hasAuthHeader: !!req.headers?.authorization,
      jwt_conversation_mismatch: req.p.jwt_conversation_mismatch,
    });
    return {};
  }

  logger.debug("Determining if JWT should be issued", {
    uid,
    pid,
    zid,
    isNewlyCreated,
    needsNewJWT,
    isXidWithoutJWT,
    hasAuthHeader: !!req.headers?.authorization,
  });

  try {
    const conversationId = (await getZinvite(zid)) as string;

    if (!conversationId) {
      throw new Error(`Could not find conversation_id for zid ${zid}`);
    }

    logger.debug("Got conversation ID for JWT", { conversationId, zid });

    // Determine which type of JWT to issue
    let token;
    let tokenType;

    if (req.p.oidc_sub) {
      // Standard user with OIDC authentication
      token = issueStandardUserJWT(req.p.oidc_sub, conversationId, uid, pid);
      tokenType = "StandardUser";
    } else if (req.p.xid) {
      // XID participant
      token = issueXidJWT(req.p.xid, conversationId, uid, pid);
      tokenType = "XID";
    } else {
      // Anonymous participant
      token = issueAnonymousJWT(conversationId, uid, pid);
      tokenType = "Anonymous";
    }

    logger.debug("JWT issued successfully", {
      tokenType,
      uid,
      pid,
      conversationId,
      oidc_sub: req.p.oidc_sub,
    });

    return { token, conversationId };
  } catch (error) {
    logger.error("Failed to issue JWT:", error);
    return {}; // Continue without JWT - maintains backward compatibility
  }
}

/**
 * Main function to ensure participant exists
 */
async function _ensureParticipantInternal(
  req: RequestWithP,
  options: EnsureParticipantOptions = {}
): Promise<ParticipantCreationResult> {
  const { createIfMissing = true, issueJWT = true, assigner } = options;

  // Try to get zid from conversation_id if not already present
  let zid = req.p.zid;
  if (!zid && req.p.conversation_id) {
    // Validate conversation_id first
    const validatedConversationId = validateConversationId(
      req.p.conversation_id
    );

    // Resolve zid from validated conversation_id
    zid = await getZidFromConversationId(validatedConversationId);
    req.p.zid = zid; // Update the request with the resolved zid
  }

  if (!zid) {
    throw new Error("polis_err_missing_zid");
  }

  let uid = req.p.uid;
  let pid = req.p.pid;
  let isNewlyCreatedUser = false;
  let isNewlyCreatedParticipant = false;
  let needsNewJWT = false;
  let legacyCookieToken: string | undefined;

  // Handle JWT conversation mismatches
  const treatedAsNew = await _handleJWTConversationMismatch(req, zid);
  if (treatedAsNew) {
    needsNewJWT = true;
  }

  // Check for legacy cookie before creating new user
  if (uid === undefined && !req.p.jwt_conversation_mismatch) {
    const conversationId = req.p.conversation_id || (await getZinvite(zid));
    if (conversationId) {
      const legacyResult = await checkLegacyCookieAndIssueJWT(
        req,
        zid,
        conversationId as string,
        req.p.xid
      );
      if (legacyResult.uid !== undefined && legacyResult.pid !== undefined) {
        uid = legacyResult.uid;
        pid = legacyResult.pid;
        needsNewJWT = legacyResult.needsNewJwt;
        legacyCookieToken = legacyResult.token;
        logger.info("Using existing participant from legacy cookie", {
          uid,
          pid,
        });
      }
    }
  }

  // Handle user identification
  // For XID users, we always need to look up the UID even if not creating
  if (uid === undefined) {
    if (req.p.xid) {
      // For XID users, try to look up existing UID
      const existingXidRecords = await getXidRecord(req.p.xid, zid);
      if (existingXidRecords && existingXidRecords.length > 0) {
        uid = existingXidRecords[0].uid;
      } else {
        // XID users should always be created on first visit, even in optional middleware
        // This is different from anonymous users because XIDs are explicit identifiers
        uid = await _handleUserIdentification(req, zid);
        isNewlyCreatedUser = true;
      }
    } else if (createIfMissing) {
      // For non-XID users, only create if createIfMissing is true
      uid = await _handleUserIdentification(req, zid);
      isNewlyCreatedUser = true;
    }
  }

  // Only throw error if we're supposed to create missing participants/users
  // and we don't have an XID (since XID users start with undefined uid)
  if (uid === undefined && createIfMissing && !req.p.xid) {
    throw new Error("polis_err_user_not_found");
  }

  // Early Treevite check - before creating new participants
  // Block unauthorized users from Treevite-enabled conversations
  if ((pid === undefined || pid === -1) && (createIfMissing || req.p.xid)) {
    // Check if this conversation requires Treevite authorization
    // Apply to both normal participant creation and XID user creation
    const convRows = (await pg.queryP_readOnly(
      "select treevite_enabled from conversations where zid = ($1);",
      [zid]
    )) as { treevite_enabled: boolean }[];

    const treeviteEnabled = !!(
      convRows &&
      convRows[0] &&
      convRows[0].treevite_enabled
    );

    if (treeviteEnabled) {
      // This person wants to become a participant in a Treevite conversation
      // but has no existing participation - block them
      throw new Error("polis_err_treevite_auth_required");
    }
  }

  // Get or create participant if needed
  if ((createIfMissing || req.p.xid) && uid !== undefined) {
    // Create participants for:
    // 1. Normal cases when createIfMissing=true
    // 2. XID users even when createIfMissing=false (they need participants on first visit)
    const participantResult = await _getOrCreateParticipant(zid, uid, pid, req);
    pid = participantResult.pid;
    isNewlyCreatedParticipant = participantResult.isNewlyCreated;
  } else if ((pid === undefined || pid === -1) && uid !== undefined) {
    // Just look up existing participant if we have a uid
    const existingPid = await getPidPromise(zid, uid, true);
    if (existingPid !== -1) {
      pid = existingPid; // Found existing participant
    }
    // For optional middleware (createIfMissing=false), don't throw if participant not found
    // Let the handler decide what to do with pid=-1
  }

  // Issue JWT if needed
  let token = legacyCookieToken;
  let conversationId: string | undefined;

  if (
    issueJWT &&
    !legacyCookieToken &&
    uid !== undefined &&
    pid !== undefined &&
    pid !== -1
  ) {
    const jwtResult = await _issueJWTIfNeeded(
      req,
      uid,
      pid,
      zid,
      isNewlyCreatedParticipant || isNewlyCreatedUser,
      needsNewJWT,
      legacyCookieToken
    );
    token = jwtResult.token;
    conversationId = jwtResult.conversationId;
  } else if (legacyCookieToken) {
    conversationId =
      req.p.conversation_id || ((await getZinvite(zid)) as string);
  }

  // Update request with final values (may be undefined for optional middleware)
  req.p.uid = uid;
  req.p.pid = pid;
  req.p.zid = zid;

  if (assigner) {
    assigner(req, "uid", uid);
    assigner(req, "pid", pid);
    assigner(req, "zid", zid);
  }

  return {
    uid,
    pid,
    isNewlyCreatedUser,
    isNewlyCreatedParticipant,
    needsNewJWT,
    token,
    conversationId,
  };
}

/**
 * Express middleware factory for ensuring participant exists
 *
 * @param options Configuration options for the middleware
 * @returns Express middleware function
 */
export function ensureParticipant(options: EnsureParticipantOptions = {}) {
  return async function ensureParticipantMiddleware(
    req: RequestWithP,
    res: Response,
    next: NextFunction
  ) {
    try {
      const result = await _ensureParticipantInternal(req, options);

      // Store the result for use in the route handler
      req.p = req.p || {};
      req.p.participantInfo = result;

      // If a JWT was issued, we can optionally attach it to the request
      // The route handler can decide whether to include it in the response
      if (result.token) {
        req.p.authToken = {
          token: result.token,
          token_type: "Bearer",
          expires_in: 365 * 24 * 60 * 60, // 1 year
        };
      }

      next();
    } catch (error) {
      logger.error("Error in ensureParticipant middleware", error);

      // Handle Treevite authentication errors with proper status code
      if (
        error instanceof Error &&
        error.message === "polis_err_treevite_auth_required"
      ) {
        return failJson(res, 401, "polis_err_treevite_auth_required");
      }

      // Pass other specific errors to the error handler
      if (error instanceof Error && error.message?.includes("polis_err")) {
        next(error);
      } else {
        next(new Error("polis_err_participant_creation"));
      }
    }
  };
}

/**
 * Optional version that doesn't fail if participant can't be created
 */
export function ensureParticipantOptional(
  options: EnsureParticipantOptions = {}
) {
  return async function ensureParticipantOptionalMiddleware(
    req: RequestWithP,
    res: Response,
    next: NextFunction
  ) {
    try {
      const result = await _ensureParticipantInternal(req, {
        ...options,
        createIfMissing: false,
      });

      req.p = req.p || {};
      req.p.participantInfo = result;

      if (result.token) {
        req.p.authToken = {
          token: result.token,
          token_type: "Bearer",
          expires_in: 365 * 24 * 60 * 60,
        };
      }

      next();
    } catch (error) {
      // Handle Treevite authentication errors even in optional middleware
      if (
        error instanceof Error &&
        error.message === "polis_err_treevite_auth_required"
      ) {
        return failJson(res, 401, "polis_err_treevite_auth_required");
      }

      // For optional middleware, we continue even if participant isn't found
      logger.debug("Participant not found (optional)", error);
      req.p = req.p || {};
      req.p.participantInfo = {
        uid: undefined,
        pid: -1, // -1 indicates "not found"
        isNewlyCreatedUser: false,
        isNewlyCreatedParticipant: false,
        needsNewJWT: false,
      };
      req.p.pid = req.p.pid !== undefined ? req.p.pid : -1;
      next();
    }
  };
}
