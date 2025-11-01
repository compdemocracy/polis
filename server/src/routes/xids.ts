import { failJson } from "../utils/fail";
import pg from "../db/pg-query";
import Utils from "../utils/common";
import type { RequestWithP, ExpressResponse } from "../d";

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

interface GetXidsRequest extends RequestWithP {
  p: {
    uid?: number;
    zid: number;
  };
}

/**
 * GET /api/v3/xids
 * Returns XID records for participants in a conversation.
 * Requires the user to be the owner of the conversation.
 */
async function handle_GET_xids(
  req: GetXidsRequest,
  res: ExpressResponse
): Promise<void> {
  const { uid, zid } = req.p;

  try {
    const isOwner = await Utils.isOwner(zid, uid);
    if (!isOwner) {
      failJson(res, 403, "polis_err_get_xids_not_authorized");
      return;
    }

    const xids = await getXids(zid);
    res.status(200).json(xids);
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

export { getXids, handle_GET_xids, handle_POST_xidWhitelist };
