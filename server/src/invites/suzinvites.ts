import _ from "underscore";

import { escapeLiteral } from "../utils/common";
import { generateToken } from "../auth";
import { getZinvite } from "../utils/zinvite";
import { sendTextEmail } from "../email/senders";
import Config from "../config";
import pg from "../db/pg-query";
import type { PostUsersInviteRequest } from "../routes/users";

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

// Helper function to generate random invitation tokens
function generateSUZinvites(count: number): string[] {
  const invites: string[] = [];
  for (let i = 0; i < count; i++) {
    // Generate a random string similar to the original implementation
    const invite =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);
    invites.push(invite);
  }
  return invites;
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

// Helper function to send invitation email
async function sendSuzinviteEmail(
  req: PostUsersInviteRequest,
  email: string,
  conversation_id: string,
  suzinvite: string
): Promise<void> {
  const serverName = Config.getServerNameWithProtocol(req);
  const body = [
    "Welcome to pol.is!",
    "",
    "Click this link to open your account:",
    "",
    `${serverName}/ot/${conversation_id}/${suzinvite}`,
    "",
    "Thank you for using Polis",
  ].join("\n");

  await sendTextEmail(
    Config.polisFromAddress,
    email,
    "Join the pol.is conversation!",
    body
  );
}

// Helper function to save invites to database
async function saveSuzinvites(
  emails: string[],
  suzinvites: string[],
  zid: number,
  owner: number
): Promise<void> {
  const pairs = _.zip(emails, suzinvites) as [string, string][];

  const valuesStatements = pairs.map(([email, suzinvite]) => {
    const xid = escapeLiteral(email);
    const suzinviteEscaped = escapeLiteral(suzinvite);
    return `(${suzinviteEscaped}, ${xid}, ${zid}, ${owner})`;
  });

  const query = `INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES ${valuesStatements.join(
    ","
  )}`;

  return new Promise((resolve, reject) => {
    pg.query(query, [], (err: any) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export {
  checkSuzinviteCodeValidity,
  createOneSuzinvite,
  generateSUZinvites,
  getSUZinviteInfo,
  saveSuzinvites,
  sendSuzinviteEmail,
};
