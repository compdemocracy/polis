import logger from "../utils/logger";
import { getParticipantByPermanentCookie } from "../participant";
import { issueAnonymousJWT } from "./anonymous-jwt";
import { issueXidJWT } from "./xid-jwt";

interface LegacyCookieResult {
  uid?: number;
  pid?: number;
  needsNewJwt: boolean;
  token?: string;
}

/**
 * Check for legacy permanent cookie and resolve existing participant if found.
 * If found, issues a new JWT for the existing participant.
 *
 * @param req - The request object
 * @param zid - The conversation ID
 * @param conversationId - The conversation string ID (for JWT)
 * @param xid - External ID if present
 * @returns Object with uid, pid, needsNewJwt flag, and token if issued
 */
export async function checkLegacyCookieAndIssueJWT(
  req: any,
  zid: number,
  conversationId: string,
  xid?: string
): Promise<LegacyCookieResult> {
  // Check if request already has JWT auth
  if (req.p?.uid !== undefined && req.p?.pid !== undefined && req.p?.pid >= 0) {
    logger.debug("Request already has JWT auth, skipping legacy cookie check");
    return { needsNewJwt: false };
  }

  // Check for permanent cookie
  const permanentCookie = req.cookies?.pc;
  if (!permanentCookie) {
    logger.debug("No permanent cookie found");
    return { needsNewJwt: false };
  }

  logger.debug("Checking for legacy participant with permanent cookie", {
    zid,
    permanentCookie: permanentCookie.substring(0, 8) + "...", // Log partial cookie for debugging
  });

  try {
    // Look up participant by permanent cookie
    const participant = await getParticipantByPermanentCookie(
      zid,
      permanentCookie
    );

    if (!participant) {
      logger.debug("No participant found for permanent cookie");
      return { needsNewJwt: false };
    }

    logger.info("Found legacy participant via permanent cookie", {
      zid,
      uid: participant.uid,
      pid: participant.pid,
    });

    // Issue appropriate JWT
    let token: string;
    if (xid) {
      token = issueXidJWT(
        xid,
        conversationId,
        participant.uid,
        participant.pid
      );
      logger.debug("Issued XID JWT for legacy participant", {
        xid,
        uid: participant.uid,
        pid: participant.pid,
      });
    } else {
      token = issueAnonymousJWT(
        conversationId,
        participant.uid,
        participant.pid
      );
      logger.debug("Issued anonymous JWT for legacy participant", {
        uid: participant.uid,
        pid: participant.pid,
      });
    }

    return {
      uid: participant.uid,
      pid: participant.pid,
      needsNewJwt: true,
      token,
    };
  } catch (error) {
    logger.error("Error checking legacy cookie", error);
    return { needsNewJwt: false };
  }
}
