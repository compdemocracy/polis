import pg from "../db/pg-query";
import logger from "../utils/logger";

import _ from "underscore";

// ===== UTILITY FUNCTIONS =====

function getSUZinviteInfo(suzinvite: any) {
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: Error) => any
  ) {
    pg.query(
      "SELECT * FROM suzinvites WHERE suzinvite = ($1);",
      [suzinvite],
      function (err: any, rows: any[]) {
        if (err) {
          reject(err);
        } else {
          resolve(rows && rows[0]);
        }
      }
    );
  });
}

const deleteSuzinvite = async (suzinvite: string): Promise<void> => {
  try {
    await pg.query("DELETE FROM suzinvites WHERE suzinvite = ($1);", [
      suzinvite,
    ]);
  } catch (err) {
    logger.error("polis_err_removing_suzinvite", err);
  }
};

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

const createXidEntry = async (
  xid: string,
  owner: number,
  uid?: number
): Promise<void> => {
  try {
    await pg.queryP("INSERT INTO xids (uid, owner, xid) VALUES ($1, $2, $3);", [
      uid,
      owner,
      xid,
    ]);
  } catch (err) {
    logger.error("polis_err_adding_xid_entry", err);
    throw new Error("polis_err_adding_xid_entry");
  }
};

export { createXidEntry, deleteSuzinvite, getSUZinviteInfo, xidExists };
