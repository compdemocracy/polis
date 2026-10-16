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
import { Response, NextFunction } from "express";

import { addParticipantAndMetadata } from "../participant";
import { checkLegacyCookieAndIssueJWT } from "./legacyCookies";
import { createAnonUser } from "./create-user";
import {
  createXidRecord,
  getXidRecord,
  isXidAllowed,
  xidExists,
} from "../xids";
import { failJson } from "../utils/fail";
import { getConversationInfo, getZidFromConversationId } from "../conversation";
import { getPidPromise } from "../user";
import { getZinvite } from "../utils/zinvite";
import { isDuplicateKey } from "../utils/common";
import { issueAnonymousJWT } from "./anonymous-jwt";
import { issueStandardUserJWT } from "./standard-user-jwt";
import { issueXidJWT } from "./xid-jwt";
import { RequestWithP } from "../d";
import logger from "../utils/logger";
import pg from "../db/pg-query";

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
 * Whether the participant token on this request was issued for a conversation
 * other than the one the route resolved.
 *
 * The JWT extractor compares the token's conversation id with the request's
 * query or body before the route has resolved anything, and those two inputs
 * can differ (the vote route reads the body). The decision is made here
 * against the resolved zid: the same conversation id string is the same
 * conversation and costs no lookup; otherwise the token's conversation id is
 * resolved (an LRU-cached read) and the zids are compared. A token for a
 * conversation that cannot be resolved counts as a token for another one.
 */
async function _tokenIsForAnotherConversation(
  req: RequestWithP,
  zid: number
): Promise<boolean> {
  const tokenConversationId = req.p.jwt_conversation_id;
  if (tokenConversationId === undefined) {
    // No participant token on this request.
    return false;
  }
  // The conversation id the route's parameter parsing read: query and params
  // are merged into the body before parsing on the routes that accept them.
  const routeConversationId = req.body?.conversation_id;
  if (
    routeConversationId !== undefined &&
    routeConversationId === tokenConversationId
  ) {
    return false;
  }
  try {
    const tokenZid = await getZidFromConversationId(tokenConversationId);
    return tokenZid !== zid;
  } catch (err) {
    return true;
  }
}

/**
 * Handle JWT conversation mismatches
 * Returns true if the request should be treated as a new participant
 */
async function _handleJWTConversationMismatch(
  req: RequestWithP
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

  if (req.p.xid_participant) {
    // An XID token for another conversation carries no identity here: its
    // uid and pid belong to the conversation that issued it, which may be
    // another owner's. The xid stays (the request's own, or the token's when
    // the request named none) and is resolved under this conversation's
    // owner like a first contact: the xid record under this owner if there
    // is one, else this conversation's xid gates and a new user.
    logger.debug(
      "XID participant with JWT for different conversation - resolving the xid under this owner"
    );
    req.p.uid = undefined;
    req.p.pid = undefined;
    return true;
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
 * The owner's allow-list, applied whenever an xid is the identity of the
 * request: a bare xid, an XID token, or an XID token with another xid in the
 * request. It runs on every action (the first join, and each vote, comment
 * and read after it). The list is the conversation owner's: an xid listed
 * for any conversation of theirs, or owner-wide, is admitted; an xid never
 * listed for this owner is refused, as is one removed from the list, from
 * then on, in every conversation of the owner that uses the list.
 *
 * Cost: one conversations read for a request whose identity is an xid, and
 * one allow-list read when the conversation uses one. A request without an
 * xid, or whose identity comes from another kind of token, reads nothing.
 */
async function _requireXidAllowed(
  req: RequestWithP,
  zid: number
): Promise<void> {
  const xidIsIdentity =
    req.p.xid !== undefined &&
    (req.p.uid === undefined || req.p.xid_participant);
  if (!xidIsIdentity) {
    return;
  }
  const conv = await getConversationInfo(zid);
  if (!conv.use_xid_whitelist) {
    return;
  }
  const isAllowed = await isXidAllowed(req.p.xid as string, zid, conv.owner);
  if (!isAllowed) {
    throw new Error("polis_err_xid_not_allowed");
  }
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

  const conv = await getConversationInfo(zid);

  // A conversation that requires an xid (an allow-list implies one) admits
  // no new user without it. Whether a named xid is on the allow-list was
  // decided by _requireXidAllowed before any identity was resolved.
  if ((conv.use_xid_whitelist || conv.xid_required) && !req.p.xid) {
    throw new Error("polis_err_xid_required");
  }

  if (req.p.xid) {
    // Handle XID users - look up or create their UID
    const existingXidRecords = await getXidRecord(req.p.xid, zid);

    if (existingXidRecords && existingXidRecords.length > 0) {
      // XID user already exists
      return existingXidRecords[0].uid;
    }

    // Create new anonymous user for this XID.
    // Note: we do NOT call createXidRecord here — the participant row doesn't
    // exist yet, so the FK (zid, pid) → participants(zid, pid) can't be
    // satisfied. xid registration happens after participant creation below.
    const newUid = await createAnonUser();

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

  // Create new participant with constraint violation protection.
  // Retry loop handles the race where a concurrent request is creating the
  // same participant: the INSERT hits a duplicate key (23505), but the
  // concurrent transaction may not have committed yet so getPidPromise
  // can't find the row. We retry a few times to let it commit.
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const rows = await addParticipantAndMetadata(zid, uid, req);
      return { pid: rows[0].pid, isNewlyCreated: true };
    } catch (createError) {
      if (isDuplicateKey(createError)) {
        // Wait briefly for the concurrent transaction to commit
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
        const retryPid = await getPidPromise(zid, uid, true);
        if (retryPid !== -1) {
          return { pid: retryPid, isNewlyCreated: false };
        }
        if (attempt === MAX_RETRIES) {
          logger.error("Failed to find participant after retries", {
            zid,
            uid,
            attempts: MAX_RETRIES + 1,
          });
          throw createError;
        }
        // Otherwise loop and retry
      } else {
        throw createError;
      }
    }
  }
  // Should not reach here, but TypeScript needs it
  throw new Error("Could not find or create participant");
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
  // 2. Participants that need a new JWT (the token presented was for another
  //    conversation, or was bound to another xid than the request named)
  // 3. Legacy cookie users who need migration
  // 4. XID participants who don't have a JWT yet (first authenticated action)
  // AND when they don't already have a valid JWT for this identity
  const isXidWithoutJWT =
    req.p.xid && !req.headers?.authorization && !legacyCookieToken;
  const shouldIssueJWT =
    (isNewlyCreated || needsNewJWT || isXidWithoutJWT) &&
    (!req.headers?.authorization || needsNewJWT);

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

  let isNewlyCreatedUser = false;
  let isNewlyCreatedParticipant = false;
  let needsNewJWT = false;
  let legacyCookieToken: string | undefined;

  // An empty or whitespace-only xid in the request names nothing. The
  // identity is then the token's xid when the token is bound to one, and
  // otherwise no xid at all, as if the parameter were absent.
  if (req.p.xid !== undefined && req.p.xid.trim() === "") {
    req.p.xid = req.p.jwt_xid;
  }

  // Decide the token's scope against the conversation the route resolved,
  // then let the handler apply its per-token-kind policy to req.p.uid and
  // req.p.pid. The identity is read from req.p only after both have run.
  req.p.jwt_conversation_mismatch = await _tokenIsForAnotherConversation(
    req,
    zid
  );
  await _handleJWTConversationMismatch(req);

  if (req.p.jwt_conversation_mismatch) {
    // A pid only has meaning in the conversation whose token carried it. A
    // token issued for another conversation never supplies this
    // conversation's pid, whatever the handler decided about the uid: the
    // participant is looked up (or created) for (zid, uid) below. And the
    // response carries a token for this conversation, so the client stops
    // presenting the other conversation's token here.
    req.p.pid = undefined;
    needsNewJWT = true;
  }

  if (req.p.xid_participant && req.p.xid !== req.p.jwt_xid) {
    // The request names an xid other than the one its token is bound to.
    // The xid is the identity, never the token's participant: it is resolved
    // on its own below, through this conversation's xid gates, and the
    // response carries a token bound to it.
    req.p.uid = undefined;
    req.p.pid = undefined;
    needsNewJWT = true;
  }

  // The allow-list applies before any identity is resolved or created.
  await _requireXidAllowed(req, zid);

  let uid = req.p.uid;
  let pid = req.p.pid;

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

  if ((pid === undefined || pid === -1) && (createIfMissing || req.p.xid)) {
    // Check if this conversation requires Treevite authorization
    // Apply to both normal participant creation and XID user creation
    const convRows = (await pg.queryP_readOnly(
      "select treevite_enabled, owner from conversations where zid = ($1);",
      [zid]
    )) as { treevite_enabled: boolean; owner: number }[];

    const treeviteEnabled = !!(
      convRows &&
      convRows[0] &&
      convRows[0].treevite_enabled
    );

    if (treeviteEnabled) {
      // Check if the current user is the conversation owner
      const isOwner = uid !== undefined && convRows[0].owner === uid;

      // An existing participant of this conversation is never a first join.
      // The identity may carry no pid for this conversation (a token issued
      // for another conversation, or no participant token at all), so its
      // membership is looked up before it can be refused; the pid found is
      // used below without a second read. A user created on this request
      // has no membership to look up.
      if (!isOwner && uid !== undefined && !isNewlyCreatedUser) {
        const existingPid = await getPidPromise(zid, uid, true);
        if (existingPid !== -1) {
          pid = existingPid;
        }
      }

      if (!isOwner && (pid === undefined || pid === -1)) {
        // This person wants to become a participant in a Treevite conversation
        // but has no existing participation and is not the owner - block them
        throw new Error("polis_err_treevite_auth_required");
      }
      // Owners are allowed to participate without an invite
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

    // Register the xid record now that the participant row exists.
    // This mirrors the order used by _joinWithZidOrSuzinvite and ensures
    // the FK (zid, pid) → participants(zid, pid) can be satisfied.
    // See: https://github.com/compdemocracy/polis/issues/2538
    if (req.p.xid && isNewlyCreatedUser && pid !== undefined) {
      const conv = await getConversationInfo(zid);
      const alreadyExists = await xidExists(req.p.xid, conv.owner, uid);
      if (!alreadyExists) {
        await createXidRecord(
          req.p.xid,
          conv.owner,
          uid,
          zid,
          req.p.x_profile_image_url,
          req.p.x_name,
          req.p.x_email
        );
      }
    }
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

      // Handle XID authentication errors with proper status codes
      if (
        error instanceof Error &&
        error.message === "polis_err_xid_required"
      ) {
        return failJson(res, 403, "polis_err_xid_required");
      }

      if (
        error instanceof Error &&
        error.message === "polis_err_xid_not_allowed"
      ) {
        return failJson(res, 403, "polis_err_xid_not_allowed");
      }

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
      // Handle XID authentication errors even in optional middleware
      if (
        error instanceof Error &&
        error.message === "polis_err_xid_required"
      ) {
        return failJson(res, 403, "polis_err_xid_required");
      }

      if (
        error instanceof Error &&
        error.message === "polis_err_xid_not_allowed"
      ) {
        return failJson(res, 403, "polis_err_xid_not_allowed");
      }

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
