import { failJson } from "../utils/fail";
import pg from "../db/pg-query";
import Utils from "../utils/common";
import type { RequestWithP, ExpressResponse } from "../d";
import { parsePagination, createPaginationMeta } from "../utils/pagination";
import logger from "../utils/logger";

// Type for XID records returned from the database
export interface XidRecord {
  pid: number;
  xid: string;
}

/**
 * Fetches XID records for participants in a conversation.
 * @param zid - Conversation ID
 * @returns Promise resolving to array of XID records
 */
async function getXids(zid: number): Promise<XidRecord[]> {
  const rows = await pg.queryP_readOnly<XidRecord>(
    "select pid, xid from xids inner join " +
      "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
      " where owner in (select org_id from conversations where zid = ($1));",
    [zid]
  );
  return Array.isArray(rows) ? rows : [];
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
    " where owner in (select org_id from conversations where zid = ($1))" +
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
      " where owner in (select org_id from conversations where zid = ($1));",
    [zid]
  );
  return result && result[0] ? parseInt(result[0].count, 10) : 0;
}

interface GetXidsRequest extends RequestWithP {
  p: {
    uid?: number;
    zid: number;
    limit?: number;
    offset?: number;
  };
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
    logger.debug("handle_GET_xids: Checking ownership", { zid, uid });
    const isOwner = await Utils.isOwner(zid, uid);
    const isPolisDev = Utils.isPolisDev(uid);
    
    if (!isOwner && !isPolisDev) {
      logger.warn("handle_GET_xids: User is not owner or polisDev", { zid, uid });
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
    const xids = await getXidsPaginated(zid, pagination.limit, pagination.offset);

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

interface PostXidWhitelistRequest extends RequestWithP {
  p: {
    xid_whitelist: string[];
    uid?: number;
  };
}

/**
 * POST /api/v3/xidWhitelist
 * Adds XIDs to the whitelist for a conversation owner.
 */
async function handle_POST_xidWhitelist(
  req: PostXidWhitelistRequest,
  res: ExpressResponse
): Promise<void> {
  const { xid_whitelist, uid: owner } = req.p;

  if (!Array.isArray(xid_whitelist) || xid_whitelist.length === 0) {
    failJson(
      res,
      400,
      "polis_err_bad_xid",
      "xid_whitelist must be a non-empty array"
    );
    return;
  }

  if (!owner) {
    failJson(res, 400, "polis_err_bad_xid", "uid is required");
    return;
  }

  const entries: string[] = [];
  try {
    for (const xid of xid_whitelist) {
      if (typeof xid !== "string" || xid.length === 0) {
        throw new Error("Invalid xid: must be a non-empty string");
      }
      entries.push(`(${Utils.escapeLiteral(xid)},${owner})`);
    }
  } catch (err) {
    failJson(res, 400, "polis_err_bad_xid", err);
    return;
  }

  try {
    await pg.queryP(
      "insert into xid_whitelist (xid, owner) values " +
        entries.join(",") +
        " on conflict do nothing;",
      []
    );
    res.status(200).json({});
  } catch (err) {
    failJson(res, 500, "polis_err_POST_xidWhitelist", err);
  }
}

export { getXids, getXidsCount, getXidsPaginated, handle_GET_xids, handle_POST_xidWhitelist };
