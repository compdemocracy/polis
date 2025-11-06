import type { ExpressResponse, RequestWithP, XidRecord } from "../d";
import { failJson } from "../utils/fail";
import { getConversationInfo } from "../conversation";
import { getXids } from "../xids";
import { parsePagination, createPaginationMeta } from "../utils/pagination";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import Utils from "../utils/common";

interface GetXidsRequest extends RequestWithP {
  p: {
    uid?: number;
    zid: number;
    limit?: number;
    offset?: number;
  };
}

interface GetXidAllowListRequest extends RequestWithP {
  p: {
    uid?: number;
    zid: number;
    limit?: number;
    offset?: number;
  };
}

interface PostXidAllowListRequest extends RequestWithP {
  p: {
    xid_allow_list: string[];
    zid: number;
    uid?: number;
  };
}

/**
 * Fetches XID records for participants in a conversation (paginated).
 * @param zid - Conversation ID
 * @param limit - Maximum number of records to return
 * @param offset - Number of records to skip
 * @returns Promise resolving to array of XID records
 */
async function getXidsPaginated(
  zid: number,
  limit: number,
  offset: number
): Promise<XidRecord[]> {
  const sql =
    "select pid, xid from xids inner join " +
    "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
    " where owner in (select owner from conversations where zid = ($1))" +
    ` LIMIT ($2) OFFSET ($3)`;
  const params: number[] = [zid, limit, offset];

  const rows = await pg.queryP_readOnly<XidRecord>(sql, params);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Gets the total count of XID records for participants in a conversation.
 * @param zid - Conversation ID
 * @returns Promise resolving to total count
 */
async function getXidsCount(zid: number): Promise<number> {
  const result = await pg.queryP_readOnly<{ count: string }>(
    "select count(*) as count from xids inner join " +
      "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
      " where owner in (select owner from conversations where zid = ($1));",
    [zid]
  );
  return result && result[0] ? parseInt(result[0].count, 10) : 0;
}

/**
 * Gets the total count of XID allow list records for a conversation.
 * Includes records where zid matches OR (zid is NULL and owner matches).
 * @param zid - Conversation ID
 * @param owner - Conversation owner UID
 * @returns Promise resolving to total count
 */
async function getXidAllowListCount(
  zid: number,
  owner: number
): Promise<number> {
  const result = await pg.queryP_readOnly<{ count: string }>(
    "select count(*) as count from xid_whitelist where (zid = ($1)) OR (zid IS NULL AND owner = ($2));",
    [zid, owner]
  );
  return result && result[0] ? parseInt(result[0].count, 10) : 0;
}

/**
 * Fetches XID allow list records for a conversation (paginated).
 * Returns records with pid if the xid is in use, null otherwise.
 * Includes records where zid matches OR (zid is NULL and owner matches).
 * @param zid - Conversation ID
 * @param owner - Conversation owner UID
 * @param limit - Maximum number of records to return
 * @param offset - Number of records to skip
 * @returns Promise resolving to array of XidRecord objects {pid: number | null, xid: string}
 */
async function getXidAllowListPaginated(
  zid: number,
  owner: number,
  limit: number,
  offset: number
): Promise<XidRecord[]> {
  // Query to match allow list xids with participants (pids) if they're in use
  // Uses LEFT JOINs to ensure all allow list entries are returned, even if not in use
  const rows = await pg.queryP_readOnly<{ pid: number | null; xid: string }>(
    `SELECT 
      wl.xid,
      p.pid
    FROM xid_whitelist wl
    LEFT JOIN xids x ON x.xid = wl.xid 
      AND (
        (x.zid = $1) OR 
        (x.zid IS NULL AND x.owner = $2)
      )
    LEFT JOIN participants p ON p.uid = x.uid AND p.zid = $1
    WHERE (wl.zid = $1) OR (wl.zid IS NULL AND wl.owner = $2)
    ORDER BY wl.xid
    LIMIT $3 OFFSET $4`,
    [zid, owner, limit, offset]
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * GET /api/v3/xids
 * Returns XID records for participants in a conversation (paginated).
 * Requires the user to be the owner of the conversation.
 */
async function handle_GET_xids(
  req: GetXidsRequest,
  res: ExpressResponse
): Promise<void> {
  const { uid, zid } = req.p;

  // Check if uid is present - authentication may have succeeded but uid extraction failed
  if (!uid) {
    logger.warn("handle_GET_xids: uid is missing from request", {
      zid,
      hasP: !!req.p,
      pKeys: req.p ? Object.keys(req.p) : [],
    });
    failJson(res, 401, "polis_err_get_xids_authentication_required");
    return;
  }

  try {
    logger.debug("handle_GET_xids: Checking moderator permissions", {
      zid,
      uid,
    });
    const isMod = await Utils.isModerator(zid, uid);

    if (!isMod) {
      logger.warn("handle_GET_xids: User is not moderator", { zid, uid });
      failJson(res, 403, "polis_err_get_xids_not_authorized");
      return;
    }

    // Parse pagination parameters
    const pagination = parsePagination(
      { limit: req.p.limit, offset: req.p.offset },
      { defaultLimit: 50, maxLimit: 500 }
    );

    // Get total count
    const total = await getXidsCount(zid);

    // Get paginated XIDs
    const xids = await getXidsPaginated(
      zid,
      pagination.limit,
      pagination.offset
    );

    // Create pagination metadata
    const paginationMeta = createPaginationMeta(
      pagination.limit,
      pagination.offset,
      total
    );

    // Return paginated response
    res.status(200).json({
      xids,
      pagination: paginationMeta,
    });
  } catch (err) {
    failJson(res, 500, "polis_err_get_xids", err);
  }
}

/**
 * GET /api/v3/xidAllowList
 * Returns a paginated array of XID strings from the xid_whitelist table for a given conversation.
 * Requires the user to be an admin, moderator, or owner of the conversation.
 */
async function handle_GET_xidAllowList(
  req: GetXidAllowListRequest,
  res: ExpressResponse
): Promise<void> {
  const { uid, zid } = req.p;

  // Check if uid is present - authentication may have succeeded but uid extraction failed
  if (!uid) {
    logger.warn("handle_GET_xidAllowList: uid is missing from request", {
      zid,
      hasP: !!req.p,
      pKeys: req.p ? Object.keys(req.p) : [],
    });
    failJson(res, 401, "polis_err_get_xidAllowList_authentication_required");
    return;
  }

  try {
    logger.debug("handle_GET_xidAllowList: Checking moderator permissions", {
      zid,
      uid,
    });

    // Check if user is moderator (includes Polis dev and site admins)
    const isMod = await Utils.isModerator(zid, uid);

    if (!isMod) {
      logger.warn("handle_GET_xidAllowList: User is not moderator", {
        zid,
        uid,
      });
      failJson(res, 403, "polis_err_get_xidAllowList_not_authorized");
      return;
    }

    // Get conversation info to retrieve owner
    const conv = await getConversationInfo(zid);
    const owner = conv.owner;

    // Parse pagination parameters
    const pagination = parsePagination(
      { limit: req.p.limit, offset: req.p.offset },
      { defaultLimit: 50, maxLimit: 500 }
    );

    // Get total count (includes zid matches and legacy owner matches)
    const total = await getXidAllowListCount(zid, owner);

    // Get paginated XIDs with pid associations (includes zid matches and legacy owner matches)
    const xids = await getXidAllowListPaginated(
      zid,
      owner,
      pagination.limit,
      pagination.offset
    );

    // Create pagination metadata
    const paginationMeta = createPaginationMeta(
      pagination.limit,
      pagination.offset,
      total
    );

    // Return paginated response with [pid, xid] pairs
    res.status(200).json({
      xids,
      pagination: paginationMeta,
    });
  } catch (err) {
    failJson(res, 500, "polis_err_get_xidAllowList", err);
  }
}

/**
 * POST /api/v3/xidAllowList
 * Adds XIDs to the allow list for a conversation.
 * Requires the user to be an admin, moderator, or owner of the conversation.
 */
async function handle_POST_xidAllowList(
  req: PostXidAllowListRequest,
  res: ExpressResponse
): Promise<void> {
  const { xid_allow_list, zid, uid } = req.p;

  // Check if uid is present - authentication may have succeeded but uid extraction failed
  if (!uid) {
    logger.warn("handle_POST_xidAllowList: uid is missing from request", {
      zid,
      hasP: !!req.p,
      pKeys: req.p ? Object.keys(req.p) : [],
    });
    failJson(res, 401, "polis_err_post_xidAllowList_authentication_required");
    return;
  }

  // Require zid
  if (!zid) {
    failJson(
      res,
      400,
      "polis_err_bad_xid",
      "conversation_id (zid) is required"
    );
    return;
  }

  if (!Array.isArray(xid_allow_list) || xid_allow_list.length === 0) {
    failJson(
      res,
      400,
      "polis_err_bad_xid",
      "xid_allow_list must be a non-empty array"
    );
    return;
  }

  try {
    logger.debug("handle_POST_xidAllowList: Checking moderator permissions", {
      zid,
      uid,
    });

    // Check if user is moderator (includes Polis dev and site admins)
    const isMod = await Utils.isModerator(zid, uid);

    if (!isMod) {
      logger.warn("handle_POST_xidAllowList: User is not moderator", {
        zid,
        uid,
      });
      failJson(res, 403, "polis_err_post_xidAllowList_not_authorized");
      return;
    }

    // Get conversation info to retrieve owner
    const conv = await getConversationInfo(zid);
    const owner = conv.owner;

    const entries: string[] = [];
    for (const xid of xid_allow_list) {
      if (typeof xid !== "string" || xid.length === 0) {
        failJson(
          res,
          400,
          "polis_err_bad_xid",
          "Invalid xid: must be a non-empty string"
        );
        return;
      }
      // Insert with zid and owner (preferred method)
      entries.push(`(${Utils.escapeLiteral(xid)},${zid},${owner})`);
    }

    // Insert with zid (preferred) and owner
    // The order is: xid, zid, owner
    await pg.queryP(
      "insert into xid_whitelist (xid, zid, owner) values " +
        entries.join(",") +
        " on conflict do nothing;",
      []
    );
    res.status(200).json({});
  } catch (err) {
    failJson(res, 500, "polis_err_POST_xidAllowList", err);
  }
}

export {
  getXids,
  handle_GET_xids,
  handle_GET_xidAllowList,
  handle_POST_xidAllowList,
};
