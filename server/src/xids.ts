import _ from "underscore";

import type { XidRecord } from "./d";
import logger from "./utils/logger";
import pg from "./db/pg-query";

/**
 * Creates or updates an XID record in the database.
 *
 * This function:
 * - Creates a new XID record linking an external ID (xid) to a user (uid) and owner
 * - Optionally associates the XID with a specific conversation (zid)
 * - Looks up and stores the participant ID (pid) if the user has already joined the conversation
 * - Handles profile metadata (name, email, profile image URL)
 * - Uses UPSERT to avoid conflicts on the (owner, xid) unique constraint
 *
 * @param xid - External identifier from the integrating system
 * @param owner - owner (uid) of the conversation that owns this XID
 * @param uid - User ID in the Polis system
 * @param zid - Optional conversation ID to associate this XID with
 * @param x_profile_image_url - Optional profile image URL from external system
 * @param x_name - Optional display name from external system
 * @param x_email - Optional email address from external system
 * @throws Error with code 'polis_err_adding_xid_record' if database operation fails
 */
async function createXidRecord(
  xid: string,
  owner: number,
  uid: number,
  zid?: number,
  x_profile_image_url?: string,
  x_name?: string,
  x_email?: string
): Promise<void> {
  try {
    // Lookup pid if zid and uid are provided and participant exists
    let pid: number | null = null;
    if (zid !== undefined && uid !== undefined) {
      try {
        const pidResult = await pg.queryP_readOnly<{ pid: number }>(
          "SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);",
          [zid, uid]
        );
        if (
          Array.isArray(pidResult) &&
          pidResult.length > 0 &&
          pidResult[0].pid !== undefined
        ) {
          pid = pidResult[0].pid;
        }
      } catch (err) {
        // If participant doesn't exist yet, pid will remain null
        logger.debug(
          "createXidRecord: participant not found, pid will be null",
          { zid, uid }
        );
      }
    }

    // Insert or update the XID record with all fields including zid and pid
    await pg.queryP(
      "INSERT INTO xids (owner, uid, xid, zid, pid, x_profile_image_url, x_name, x_email) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) " +
        "ON CONFLICT (owner, xid) DO UPDATE SET " +
        "zid = COALESCE(EXCLUDED.zid, xids.zid), " +
        "pid = COALESCE(EXCLUDED.pid, xids.pid), " +
        "x_profile_image_url = COALESCE(EXCLUDED.x_profile_image_url, xids.x_profile_image_url), " +
        "x_name = COALESCE(EXCLUDED.x_name, xids.x_name), " +
        "x_email = COALESCE(EXCLUDED.x_email, xids.x_email);",
      [
        owner,
        uid,
        xid,
        zid || null,
        pid,
        x_profile_image_url || null,
        x_name || null,
        x_email || null,
      ]
    );
  } catch (err) {
    logger.error("polis_err_adding_xid_record", err);
    throw new Error("polis_err_adding_xid_record");
  }
}

/**
 * Looks up XID records in the database.
 *
 * This function supports two lookup strategies:
 * 1. By conversation (zid): Looks up xid + owner where owner is derived from the conversation
 *    - This is the preferred method as it's conversation-scoped
 * 2. By owner directly: Looks up xid + owner for legacy records that may not have zid data
 *    - This is a fallback for older XID records created before the zid field was added
 *
 * @param xid - External identifier from the integrating system
 * @param zid - Optional conversation ID (preferred lookup method)
 * @param owner - Optional owner uid (fallback for legacy records without zid)
 * @returns Promise resolving to array of XID records (empty array if not found)
 * @throws Error if neither zid nor owner is provided
 */
async function getXidRecord(
  xid: string,
  zid?: number | null,
  owner?: number | null
): Promise<XidRecord[]> {
  // Require at least one lookup parameter
  if (
    (zid === undefined || zid === null) &&
    (owner === undefined || owner === null)
  ) {
    throw new Error("getXidRecord requires either zid or owner parameter");
  }

  // Preferred: Look up by xid + conversation (derives owner from zid)
  if (zid !== undefined && zid !== null) {
    const rows = await pg.queryP(
      "SELECT * FROM xids WHERE xid = ($1) AND owner = (SELECT owner FROM conversations WHERE zid = ($2));",
      [xid, zid]
    );
    return (rows as XidRecord[]) || [];
  }

  // Fallback: Look up by xid + owner directly (for legacy records without zid)
  if (owner !== undefined && owner !== null) {
    const rows = await pg.queryP(
      "SELECT * FROM xids WHERE xid = ($1) AND owner = ($2);",
      [xid, owner]
    );
    return (rows as XidRecord[]) || [];
  }

  return [];
}

/**
 * Fetches XID records for participants in a conversation.
 * @param zid - Conversation ID
 * @returns Promise resolving to array of XID records
 */
async function getXids(zid: number): Promise<XidRecord[]> {
  const rows = await pg.queryP_readOnly<XidRecord>(
    "select p.pid, xids.xid from xids inner join " +
      "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
      " where xids.owner in (select owner from conversations where zid = ($1));",
    [zid]
  );
  return Array.isArray(rows) ? rows : [];
}

async function isXidAllowed(
  xid: string,
  zid?: number,
  owner?: number
): Promise<boolean> {
  // Try zid+xid first (preferred method)
  if (zid !== undefined) {
    const rowsByZid = await pg.queryP(
      "select * from xid_whitelist where zid = ($1) and xid = ($2);",
      [zid, xid]
    );
    if (Array.isArray(rowsByZid) && rowsByZid.length > 0) {
      return true;
    }
  }

  // Fallback to owner+xid, but ONLY on records where zid is null
  if (owner !== undefined) {
    const rowsByOwner = await pg.queryP(
      "select * from xid_whitelist where zid IS NULL and owner = ($1) and xid = ($2);",
      [owner, xid]
    );
    if (Array.isArray(rowsByOwner) && rowsByOwner.length > 0) {
      return true;
    }
  }

  return false;
}

function xidExists(xid: string, owner: number, uid?: number) {
  return pg
    .queryP(
      "select * from xids where xid = ($1) and owner = ($2) and uid = ($3);",
      [xid, owner, uid]
    )
    .then(function (rows: string | any[]) {
      return rows && rows.length;
    });
}

export { createXidRecord, getXidRecord, getXids, isXidAllowed, xidExists };
