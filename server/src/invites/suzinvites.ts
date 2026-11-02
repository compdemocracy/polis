import _ from "underscore";

import { generateToken } from "../auth";
import { getZinvite } from "../utils/zinvite";
import pg from "../db/pg-query";

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

function createOneSuzinvite(
  xid: string,
  zid: number,
  owner: number,
  generateSingleUseUrl: (arg0: any, arg1: any) => any
) {
  return _generateSUZinvitesP(1).then(function (suzinviteArray: any[]) {
    const suzinvite = suzinviteArray[0];
    return pg
      .queryP(
        "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES ($1, $2, $3, $4);",
        [suzinvite, xid, zid, owner]
      )
      .then(function () {
        return getZinvite(zid);
      })
      .then(function (conversation_id: string) {
        return {
          zid: zid,
          conversation_id: conversation_id,
        };
      })
      .then(function (o: { zid: number; conversation_id: string }) {
        return {
          zid: o.zid,
          conversation_id: o.conversation_id,
          suurl: generateSingleUseUrl(o.conversation_id, suzinvite),
        };
      });
  });
}

function checkSuzinviteCodeValidity(
  zid: number,
  suzinvite: string,
  callback: (err: number | null) => void
) {
  pg.query(
    "SELECT * FROM suzinvites WHERE zid = ($1) AND suzinvite = ($2);",
    [zid, suzinvite],
    function (err: any, results: { rows: string | any[] }) {
      if (err || !results || !results.rows || !results.rows.length) {
        callback(1);
      } else {
        callback(null); // ok
      }
    }
  );
}

function _generateConversationURLPrefix() {
  // not 1 or 0 since they look like "l" and "O"
  return "" + _.random(2, 9);
}

function _generateSUZinvitesP(numTokens: number) {
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: Error) => void
  ) {
    generateToken(
      31 * numTokens,
      // For now, pseodorandom bytes are probably ok. Anticipating API call will generate
      // lots of these at once, possibly draining the entropy pool.
      // Revisit this if the otzinvites really need to be unguessable.
      true,
      function (err: any, longStringOfTokens?: string) {
        if (err) {
          reject(new Error("polis_err_creating_otzinvite"));
          return;
        }
        const otzinviteArrayRegexMatch = longStringOfTokens?.match(/.{1,31}/g);
        // Base64 encoding expands to extra characters, so trim to the number of tokens we want.
        let otzinviteArray = otzinviteArrayRegexMatch?.slice(0, numTokens);
        otzinviteArray = otzinviteArray?.map(function (suzinvite: string) {
          return _generateConversationURLPrefix() + suzinvite;
        });
        resolve(otzinviteArray);
      }
    );
  });
}

export { checkSuzinviteCodeValidity, createOneSuzinvite, getSUZinviteInfo };
