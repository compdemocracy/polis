import LruCache from "lru-cache";

import pg from "./db/pg-query";
import { MPromise } from "./utils/metered";

function createXidRecord(
  ownerUid: any,
  uid: any,
  xid: any,
  x_profile_image_url: any,
  x_name: any,
  x_email: any
) {
  return pg.queryP(
    "insert into xids (owner, uid, xid, x_profile_image_url, x_name, x_email) values ($1, $2, $3, $4, $5, $6) " +
      "on conflict (owner, xid) do nothing;",
    [
      ownerUid,
      uid,
      xid,
      x_profile_image_url || null,
      x_name || null,
      x_email || null,
    ]
  );
}

function createXidRecordByZid(
  zid: any,
  uid: any,
  xid: any,
  x_profile_image_url: any,
  x_name: any,
  x_email: any
) {
  return getConversationInfo(zid).then((conv: any) => {
    const shouldCreateXidRecord = conv.use_xid_whitelist
      ? isXidWhitelisted(conv.owner, xid)
      : Promise.resolve(true);
    return shouldCreateXidRecord.then((should: any) => {
      if (!should) {
        throw new Error("polis_err_xid_not_whitelisted_2");
      }
      return pg.queryP(
        "insert into xids (owner, uid, xid, x_profile_image_url, x_name, x_email) values ((select org_id from conversations where zid = ($1)), $2, $3, $4, $5, $6) " +
          "on conflict (owner, xid) do nothing;",
        [
          zid,
          uid,
          xid,
          x_profile_image_url || null,
          x_name || null,
          x_email || null,
        ]
      );
    });
  });
}

function getXidRecord(xid: any, zid: any) {
  return pg.queryP(
    "select * from xids where xid = ($1) and owner = (select org_id from conversations where zid = ($2));",
    [xid, zid]
  );
}

function isXidWhitelisted(owner: any, xid: any) {
  return pg
    .queryP("select * from xid_whitelist where owner = ($1) and xid = ($2);", [
      owner,
      xid,
    ])
    .then((rows: any) => {
      return !!rows && rows.length > 0;
    });
}

function getConversationInfo(zid: any) {
  //   (alias) function MPromise(name: string, f: (resolve: (value: unknown) => void, reject: (reason?: any) => void) => void): Promise<unknown>
  // import MPromise
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  //
  return MPromise(
    "getConversationInfo",
    function (resolve: (arg0: any) => void, reject: (arg0: any) => void) {
      pg.query(
        "SELECT * FROM conversations WHERE zid = ($1);",
        [zid],
        function (err: any, result: { rows: any[] }) {
          if (err) {
            reject(err);
          } else {
            resolve(result.rows[0]);
          }
        }
      );
    }
  );
}

function getConversationInfoByConversationId(conversation_id: any) {
  //   (alias) function MPromise(name: string, f: (resolve: (value: unknown) => void, reject: (reason?: any) => void) => void): Promise<unknown>
  // import MPromise
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  //
  return MPromise(
    "getConversationInfoByConversationId",
    function (resolve: (arg0: any) => void, reject: (arg0: any) => void) {
      pg.query(
        "SELECT * FROM conversations WHERE zid = (select zid from zinvites where zinvite = ($1));",
        [conversation_id],
        function (err: any, result: { rows: any[] }) {
          if (err) {
            reject(err);
          } else {
            resolve(result.rows[0]);
          }
        }
      );
    }
  );
}

const conversationIdToZidCache = new LruCache({
  max: 1000,
});

// NOTE: currently conversation_id is stored as zinvite
function getZidFromConversationId(conversation_id: string) {
  //   (alias) function MPromise(name: string, f: (resolve: (value: unknown) => void, reject: (reason?: any) => void) => void): Promise<unknown>
  // import MPromise
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  //
  return MPromise(
    "getZidFromConversationId",
    function (resolve: (arg0: any) => void, reject: (arg0: string) => any) {
      let cachedZid = conversationIdToZidCache.get(conversation_id);
      if (cachedZid) {
        resolve(cachedZid);
        return;
      }
      pg.query_readOnly(
        "select zid from zinvites where zinvite = ($1);",
        [conversation_id],
        function (err: any, results: { rows: string | any[] }) {
          if (err) {
            return reject(err);
          } else if (!results || !results.rows || !results.rows.length) {
            console.error(
              "polis_err_fetching_zid_for_conversation_id " + conversation_id
            );
            return reject("polis_err_fetching_zid_for_conversation_id");
          } else {
            let zid = results.rows[0].zid;
            conversationIdToZidCache.set(conversation_id, zid);
            return resolve(zid);
          }
        }
      );
    }
  );
}

export {
  createXidRecordByZid,
  getXidRecord,
  isXidWhitelisted,
  getConversationInfo,
  getConversationInfoByConversationId,
  getZidFromConversationId,
};

export default {
  createXidRecordByZid,
  createXidRecord,
  getXidRecord,
  isXidWhitelisted,
  getConversationInfo,
  getConversationInfoByConversationId,
  getZidFromConversationId,
};
