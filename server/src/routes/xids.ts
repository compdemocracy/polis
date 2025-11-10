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
    replace_all?: boolean;
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
    "select p.pid, xids.xid, COALESCE(p.vote_count, 0) as vote_count from xids inner join " +
    "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
    " where xids.owner in (select owner from conversations where zid = ($1))" +
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
      " where xids.owner in (select owner from conversations where zid = ($1));",
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
 * If replace_all is true, removes existing XIDs that are not in the incoming list.
 * Requires the user to be an admin, moderator, or owner of the conversation.
 */
async function handle_POST_xidAllowList(
  req: PostXidAllowListRequest,
  res: ExpressResponse
): Promise<void> {
  const { xid_allow_list, zid, uid, replace_all } = req.p;

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

    // Validate all XIDs first
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
    }

    // If replace_all is true, delete existing XIDs that are not in the incoming list
    // This preserves existing pids for XIDs that are being kept
    if (replace_all) {
      logger.debug(
        "handle_POST_xidAllowList: replace_all is true, deleting non-matching XIDs",
        {
          zid,
          incomingCount: xid_allow_list.length,
        }
      );

      // Create a set of incoming XIDs for efficient lookup
      const incomingXidSet = new Set(
        xid_allow_list.map((xid) => xid.toLowerCase())
      );

      // Get all existing XIDs for this conversation (zid matches or legacy owner matches)
      const existingRows = await pg.queryP_readOnly<{ xid: string }>(
        "SELECT xid FROM xid_whitelist WHERE (zid = $1) OR (zid IS NULL AND owner = $2);",
        [zid, owner]
      );

      if (Array.isArray(existingRows) && existingRows.length > 0) {
        // Find XIDs to delete (those not in incoming list)
        const xidsToDelete: string[] = [];
        for (const row of existingRows) {
          if (!incomingXidSet.has(row.xid.toLowerCase())) {
            xidsToDelete.push(row.xid);
          }
        }

        // Delete XIDs that are not in the incoming list
        if (xidsToDelete.length > 0) {
          logger.debug(
            "handle_POST_xidAllowList: deleting XIDs not in incoming list",
            {
              zid,
              deleteCount: xidsToDelete.length,
            }
          );

          // Delete by matching zid + xid (preferred) or owner + xid (legacy)
          // Use parameterized query for safety
          const xidPlaceholders = xidsToDelete
            .map((_, idx) => `$${idx + 1}`)
            .join(",");
          const deleteParams = xidsToDelete.map((xid) => xid);

          await pg.queryP(
            "DELETE FROM xid_whitelist WHERE xid IN (" +
              xidPlaceholders +
              ") AND ((zid = $" +
              (xidsToDelete.length + 1) +
              ") OR (zid IS NULL AND owner = $" +
              (xidsToDelete.length + 2) +
              "));",
            [...deleteParams, zid, owner]
          );
        }
      }
    }

    // Insert all incoming XIDs (will preserve existing ones due to on conflict do nothing)
    const entries: string[] = [];
    for (const xid of xid_allow_list) {
      // Insert with zid and owner (preferred method)
      entries.push(`(${Utils.escapeLiteral(xid)},${zid},${owner})`);
    }

    // Insert with zid (preferred) and owner
    // The order is: xid, zid, owner
    // on conflict do nothing preserves existing records (including their pids if any)
    await pg.queryP(
      "insert into xid_whitelist (xid, zid, owner) values " +
        entries.join(",") +
        " on conflict do nothing;",
      []
    );

    logger.debug("handle_POST_xidAllowList: completed", {
      zid,
      insertedCount: xid_allow_list.length,
      replaceAll: replace_all || false,
    });

    res.status(200).json({});
  } catch (err) {
    failJson(res, 500, "polis_err_POST_xidAllowList", err);
  }
}

/**
 * Escapes a value for CSV format.
 * @param value - Value to escape
 * @returns Escaped CSV string
 */
function escapeCsv(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const needsQuoting = /[",\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

/**
 * GET /api/v3/xids/csv
 * Downloads XID records for participants in a conversation as CSV.
 * Requires the user to be the owner of the conversation.
 */
async function handle_GET_xids_csv(
  req: GetXidsRequest,
  res: ExpressResponse
): Promise<void> {
  const { uid, zid } = req.p;

  // Check if uid is present - authentication may have succeeded but uid extraction failed
  if (!uid) {
    logger.warn("handle_GET_xids_csv: uid is missing from request", {
      zid,
      hasP: !!req.p,
      pKeys: req.p ? Object.keys(req.p) : [],
    });
    failJson(res, 401, "polis_err_get_xids_csv_authentication_required");
    return;
  }

  try {
    logger.debug("handle_GET_xids_csv: Checking moderator permissions", {
      zid,
      uid,
    });
    const isMod = await Utils.isModerator(zid, uid);

    if (!isMod) {
      logger.warn("handle_GET_xids_csv: User is not moderator", { zid, uid });
      failJson(res, 403, "polis_err_get_xids_csv_not_authorized");
      return;
    }

    // Get all XIDs (no pagination)
    const xids = await getXidsPaginated(zid, 1000000, 0); // Get all records

    // Build CSV
    const headers = ["pid", "xid", "vote_count"];
    const lines: string[] = [];
    lines.push(headers.join(","));
    for (const xidRecord of xids) {
      const values = [
        xidRecord.pid ?? "",
        xidRecord.xid ?? "",
        xidRecord.vote_count ?? 0,
      ].map(escapeCsv);
      lines.push(values.join(","));
    }

    const csv = lines.join("\n");

    // Set headers for CSV download
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="xids_in_use_${zid}_${timestamp}.csv"`
    );
    // Type assertion needed because ExpressResponse.send is optional in type definition
    (res as { send: (data: string) => void }).send(csv);
  } catch (err) {
    failJson(res, 500, "polis_err_get_xids_csv", err);
  }
}

/**
 * GET /api/v3/xidAllowList/csv
 * Downloads XID allow list records for a conversation as CSV.
 * Requires the user to be an admin, moderator, or owner of the conversation.
 */
async function handle_GET_xidAllowList_csv(
  req: GetXidAllowListRequest,
  res: ExpressResponse
): Promise<void> {
  const { uid, zid } = req.p;

  // Check if uid is present - authentication may have succeeded but uid extraction failed
  if (!uid) {
    logger.warn("handle_GET_xidAllowList_csv: uid is missing from request", {
      zid,
      hasP: !!req.p,
      pKeys: req.p ? Object.keys(req.p) : [],
    });
    failJson(
      res,
      401,
      "polis_err_get_xidAllowList_csv_authentication_required"
    );
    return;
  }

  try {
    logger.debug(
      "handle_GET_xidAllowList_csv: Checking moderator permissions",
      {
        zid,
        uid,
      }
    );

    // Check if user is moderator (includes Polis dev and site admins)
    const isMod = await Utils.isModerator(zid, uid);

    if (!isMod) {
      logger.warn("handle_GET_xidAllowList_csv: User is not moderator", {
        zid,
        uid,
      });
      failJson(res, 403, "polis_err_get_xidAllowList_csv_not_authorized");
      return;
    }

    // Get conversation info to retrieve owner
    const conv = await getConversationInfo(zid);
    const owner = conv.owner;

    // Get all XID allow list records (no pagination)
    const xids = await getXidAllowListPaginated(zid, owner, 1000000, 0); // Get all records

    // Build CSV
    const headers = ["pid", "xid"];
    const lines: string[] = [];
    lines.push(headers.join(","));
    for (const xidRecord of xids) {
      const values = [xidRecord.pid ?? "", xidRecord.xid ?? ""].map(escapeCsv);
      lines.push(values.join(","));
    }

    const csv = lines.join("\n");

    // Set headers for CSV download
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="xid_allow_list_${zid}_${timestamp}.csv"`
    );
    // Type assertion needed because ExpressResponse.send is optional in type definition
    (res as { send: (data: string) => void }).send(csv);
  } catch (err) {
    failJson(res, 500, "polis_err_get_xidAllowList_csv", err);
  }
}

export {
  getXids,
  handle_GET_xids,
  handle_GET_xidAllowList,
  handle_POST_xidAllowList,
  handle_GET_xids_csv,
  handle_GET_xidAllowList_csv,
};
