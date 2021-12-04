import _ from "underscore";
import LruCache from "lru-cache";

import pg from "./db/pg-query";
import { MPromise } from "./utils/metered";

import Config from "./config";
import Conversation from "./conversation";
import Log from "./log";
import LRUCache from "lru-cache";

function getUserInfoForUid(
  uid: any,
  callback: (arg0: null, arg1?: undefined) => void
) {
  pg.query_readOnly(
    "SELECT email, hname from users where uid = $1",
    [uid],
    function (err: any, results: { rows: string | any[] }) {
      if (err) {
        return callback(err);
      }
      if (!results.rows || !results.rows.length) {
        return callback(null);
      }
      callback(null, results.rows[0]);
    }
  );
}

function getUserInfoForUid2(uid: any) {
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  // @ts-ignore
  return new MPromise(
    "getUserInfoForUid2",
    function (resolve: (arg0: any) => void, reject: (arg0: null) => any) {
      pg.query_readOnly(
        "SELECT * from users where uid = $1",
        [uid],
        function (err: any, results: { rows: string | any[] }) {
          if (err) {
            return reject(err);
          }
          if (!results.rows || !results.rows.length) {
            return reject(null);
          }
          let o = results.rows[0];
          resolve(o);
        }
      );
    }
  );
}

function addLtiUserIfNeeded(
  uid: any,
  lti_user_id: any,
  tool_consumer_instance_guid: any,
  lti_user_image: null
) {
  lti_user_image = lti_user_image || null;
  return (
    pg
      .queryP(
        "select * from lti_users where lti_user_id = ($1) and tool_consumer_instance_guid = ($2);",
        [lti_user_id, tool_consumer_instance_guid]
      )
      //     (local function)(rows: string | any[]): Promise<unknown> | undefined
      // Argument of type '(rows: string | any[]) => Promise<unknown> | undefined' is not assignable to parameter of type '(value: unknown) => unknown'.
      //   Types of parameters 'rows' and 'value' are incompatible.
      //     Type 'unknown' is not assignable to type 'string | any[]'.
      //       Type 'unknown' is not assignable to type 'any[]'.ts(2345)
      // @ts-ignore
      .then(function (rows: string | any[]) {
        if (!rows || !rows.length) {
          return pg.queryP(
            "insert into lti_users (uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) values ($1, $2, $3, $4);",
            [uid, lti_user_id, tool_consumer_instance_guid, lti_user_image]
          );
        }
      })
  );
}

function addLtiContextMembership(
  uid: any,
  lti_context_id: any,
  tool_consumer_instance_guid: any
) {
  return (
    pg
      .queryP(
        "select * from lti_context_memberships where uid = $1 and lti_context_id = $2 and tool_consumer_instance_guid = $3;",
        [uid, lti_context_id, tool_consumer_instance_guid]
      )
      //     (local function)(rows: string | any[]): Promise<unknown> | undefined
      // Argument of type '(rows: string | any[]) => Promise<unknown> | undefined' is not assignable to parameter of type '(value: unknown) => unknown'.
      //   Types of parameters 'rows' and 'value' are incompatible.
      //     Type 'unknown' is not assignable to type 'string | any[]'.
      //       Type 'unknown' is not assignable to type 'any[]'.ts(2345)
      // @ts-ignore
      .then(function (rows: string | any[]) {
        if (!rows || !rows.length) {
          return pg.queryP(
            "insert into lti_context_memberships (uid, lti_context_id, tool_consumer_instance_guid) values ($1, $2, $3);",
            [uid, lti_context_id, tool_consumer_instance_guid]
          );
        }
      })
  );
}

function renderLtiLinkageSuccessPage(
  req: any,
  res: {
    set: (arg0: { "Content-Type": string }) => void;
    status: (
      arg0: number
    ) => { (): any; new (): any; send: { (arg0: string): void; new (): any } };
  },
  o: { email: string }
) {
  res.set({
    "Content-Type": "text/html",
  });
  let html =
    "" +
    "<!DOCTYPE html><html lang='en'>" +
    "<head>" +
    '<meta name="viewport" content="width=device-width, initial-scale=1;">' +
    "</head>" +
    "<body style='max-width:320px'>" +
    "<p>You are signed in as polis user " +
    o.email +
    "</p>" +
    // "<p><a href='https://pol.is/user/logout'>Change pol.is users</a></p>" +
    // "<p><a href='https://preprod.pol.is/inbox/context="+ o.context_id +"'>inbox</a></p>" +
    // "<p><a href='https://preprod.pol.is/2demo' target='_blank'>2demo</a></p>" +
    // "<p><a href='https://preprod.pol.is/conversation/create/context="+ o.context_id +"'>create</a></p>" +

    // form for sign out
    '<p><form role="form" class="FormVertical" action="' +
    Config.getServerNameWithProtocol(req) +
    '/api/v3/auth/deregister" method="POST">' +
    '<input type="hidden" name="showPage" value="canvas_assignment_deregister">' +
    '<button type="submit" class="Btn Btn-primary">Change pol.is users</button>' +
    "</form></p>" +
    // "<p style='background-color: yellow;'>" +
    //     JSON.stringify(req.body)+
    //     (o.user_image ? "<img src='"+o.user_image+"'></img>" : "") +
    // "</p>"+
    "</body></html>";
  res.status(200).send(html);
}

async function getUser(
  uid: number,
  zid_optional: any,
  xid_optional: any,
  owner_uid_optional: any
) {
  if (!uid) {
    // this api may be called by a new user, so we don't want to trigger a failure here.
    return Promise.resolve({});
  }

  let xidInfoPromise = Promise.resolve(null);
  if (zid_optional && xid_optional) {
    //     let xidInfoPromise: Promise<null>
    // Type 'Promise<unknown>' is not assignable to type 'Promise<null>'.
    //       Type 'unknown' is not assignable to type 'null'.ts(2322)
    // @ts-ignore
    xidInfoPromise = Conversation.getXidRecord(xid_optional, zid_optional);
  } else if (xid_optional && owner_uid_optional) {
    // let xidInfoPromise: Promise<null>
    // Type 'Promise<unknown>' is not assignable to type 'Promise<null>'.ts(2322)
    // @ts-ignore
    xidInfoPromise = Conversation.getXidRecordByXidOwnerId(
      xid_optional,
      owner_uid_optional,
      zid_optional
    );
  }

  const o: any[] = await Promise.all([
    getUserInfoForUid2(uid),
    getFacebookInfo([uid]),
    getTwitterInfo([uid]),
    xidInfoPromise,
  ]);
  let info = o[0];
  let fbInfo = o[1];
  let twInfo = o[2];
  let xInfo = o[3];
  let hasFacebook = fbInfo && fbInfo.length && fbInfo[0];
  let hasTwitter = twInfo && twInfo.length && twInfo[0];
  let hasXid = xInfo && xInfo.length && xInfo[0];
  if (hasFacebook) {
    let width = 40;
    let height = 40;
    fbInfo.fb_picture =
      "https://graph.facebook.com/v2.2/" +
      fbInfo.fb_user_id +
      "/picture?width=" +
      width +
      "&height=" +
      height;
    delete fbInfo[0].response;
  }
  if (hasTwitter) {
    delete twInfo[0].response;
  }
  if (hasXid) {
    delete xInfo[0].owner;
    delete xInfo[0].created;
    delete xInfo[0].uid;
  }
  return {
    uid: uid,
    email: info.email,
    hname: info.hname,
    hasFacebook: !!hasFacebook,
    facebook: fbInfo && fbInfo[0],
    twitter: twInfo && twInfo[0],
    hasTwitter: !!hasTwitter,
    hasXid: !!hasXid,
    xInfo: xInfo && xInfo[0],
    finishedTutorial: !!info.tut,
    site_ids: [info.site_id],
    created: Number(info.created),
    daysInTrial: 10 + (usersToAdditionalTrialDays[uid] || 0),
  };
}

function getTwitterInfo(uids: any[]) {
  return pg.queryP_readOnly(
    "select * from twitter_users where uid in ($1);",
    uids
  );
}

function getFacebookInfo(uids: any[]) {
  return pg.queryP_readOnly(
    "select * from facebook_users where uid in ($1);",
    uids
  );
}

// so we can grant extra days to users
// eventually we should probably move this to db.
// for now, use git blame to see when these were added
const usersToAdditionalTrialDays: { [key: number]: number } = {
  50756: 14, // julien
  85423: 100, // mike test
};

function createDummyUser() {
  // (parameter) resolve: (arg0: any) => void
  //   'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  // @ts-ignore
  return new MPromise(
    "createDummyUser",
    function (resolve: (arg0: any) => void, reject: (arg0: Error) => void) {
      pg.query(
        "INSERT INTO users (created) VALUES (default) RETURNING uid;",
        [],
        function (err: any, results: { rows: string | any[] }) {
          if (err || !results || !results.rows || !results.rows.length) {
            console.error(err);
            reject(new Error("polis_err_create_empty_user"));
            return;
          }
          resolve(results.rows[0].uid);
        }
      );
    }
  );
}

let pidCache: LRUCache<string, number> = new LruCache({
  max: 9000,
});

// returns a pid of -1 if it's missing
function getPid(
  zid: string,
  uid: string,
  callback: (arg0: null, arg1: number) => void
) {
  let cacheKey = zid + "_" + uid;
  let cachedPid = pidCache.get(cacheKey);
  if (!_.isUndefined(cachedPid)) {
    callback(null, cachedPid);
    return;
  }
  pg.query_readOnly(
    "SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);",
    [zid, uid],
    function (err: any, docs: { rows: { pid: number }[] }) {
      let pid = -1;
      if (docs && docs.rows && docs.rows[0]) {
        pid = docs.rows[0].pid;
        pidCache.set(cacheKey, pid);
      }
      callback(err, pid);
    }
  );
}

// returns a pid of -1 if it's missing
function getPidPromise(zid: string, uid: string, usePrimary?: boolean) {
  let cacheKey = zid + "_" + uid;
  let cachedPid = pidCache.get(cacheKey);
  //   (alias) function MPromise(name: string, f: (resolve: (value: unknown) => void, reject: (reason?: any) => void) => void): Promise<unknown>
  // import MPromise
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  // @ts-ignore
  return new MPromise(
    "getPidPromise",
    function (resolve: (arg0: number) => void, reject: (arg0: any) => any) {
      if (!_.isUndefined(cachedPid)) {
        resolve(cachedPid);
        return;
      }
      const f = usePrimary ? pg.query : pg.query_readOnly;
      f(
        "SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);",
        [zid, uid],
        function (err: any, results: { rows: string | any[] }) {
          if (err) {
            return reject(err);
          }
          if (!results || !results.rows || !results.rows.length) {
            resolve(-1);
            return;
          }
          let pid = results.rows[0].pid;
          pidCache.set(cacheKey, pid);
          resolve(pid);
        }
      );
    }
  );
}

// must follow auth and need('zid'...) middleware
function getPidForParticipant(
  assigner: (arg0: any, arg1: string, arg2: any) => void,
  cache: any
) {
  return function (
    req: { p: { zid: any; uid: any } },
    res: any,
    next: (arg0?: string) => void
  ) {
    let zid = req.p.zid;
    let uid = req.p.uid;

    function finish(pid: any) {
      assigner(req, "pid", pid);
      next();
    }
    getPidPromise(zid, uid).then(
      function (pid: number) {
        if (pid === -1) {
          let msg = "polis_err_get_pid_for_participant_missing";
          Log.yell(msg);

          console.log("info", zid);
          console.log("info", uid);
          console.log("info", req.p);
          next(msg);
        }
        finish(pid);
      },
      function (err: any) {
        Log.yell("polis_err_get_pid_for_participant");
        next(err);
      }
    );
  };
}

function getSocialInfoForUsers(uids: any[], zid: any) {
  uids = _.uniq(uids);
  uids.forEach(function (uid: string) {
    if (!_.isNumber(uid)) {
      throw "polis_err_123123_invalid_uid got:" + uid;
    }
  });
  if (!uids.length) {
    return Promise.resolve([]);
  }
  let uidString = uids.join(",");
  return pg.queryP_metered_readOnly(
    "getSocialInfoForUsers",
    "with " +
      "x as (select * from xids where uid in (" +
      uidString +
      ") and owner  in (select org_id from conversations where zid = ($1))), " +
      "fb as (select * from facebook_users where uid in (" +
      uidString +
      ")), " +
      "tw as (select * from twitter_users where uid in (" +
      uidString +
      ")), " +
      "foo as (select *, coalesce(fb.uid, tw.uid) as foouid from fb full outer join tw on tw.uid = fb.uid) " +
      "select *, coalesce(foo.foouid, x.uid) as uid from foo full outer join x on x.uid = foo.foouid;",
    [zid]
  );
}

function getXidRecordByXidOwnerId(
  xid: any,
  owner: any,
  zid_optional: any,
  x_profile_image_url: any,
  x_name: any,
  x_email: any,
  createIfMissing: any
) {
  return (
    pg
      .queryP("select * from xids where xid = ($1) and owner = ($2);", [
        xid,
        owner,
      ])
      //     (local function)(rows: string | any[]): any
      // Argument of type '(rows: string | any[]) => any' is not assignable to parameter of type '(value: unknown) => any'.
      //   Types of parameters 'rows' and 'value' are incompatible.
      //     Type 'unknown' is not assignable to type 'string | any[]'.
      //     Type 'unknown' is not assignable to type 'any[]'.ts(2345)
      // @ts-ignore
      .then(function (rows: string | any[]) {
        if (!rows || !rows.length) {
          console.log("no xInfo yet");
          if (!createIfMissing) {
            return null;
          }

          var shouldCreateXidEntryPromise = !zid_optional
            ? Promise.resolve(true)
            : Conversation.getConversationInfo(zid_optional).then(
                (conv: { use_xid_whitelist: any }) => {
                  return conv.use_xid_whitelist
                    ? Conversation.isXidWhitelisted(owner, xid)
                    : Promise.resolve(true);
                }
              );

          return shouldCreateXidEntryPromise.then((should: any) => {
            if (!should) {
              return null;
            }
            return createDummyUser().then((newUid: any) => {
              console.log("created dummy");
              return Conversation.createXidRecord(
                owner,
                newUid,
                xid,
                x_profile_image_url || null,
                x_name || null,
                x_email || null
              ).then(() => {
                console.log("created xInfo");
                return [
                  {
                    uid: newUid,
                    owner: owner,
                    xid: xid,
                    x_profile_image_url: x_profile_image_url,
                    x_name: x_name,
                    x_email: x_email,
                  },
                ];
              });
            });
          });
        }
        return rows;
      })
  );
}

function getXidStuff(xid: any, zid: any) {
  // Argument of type '(rows: string | any[]) => any' is not assignable to parameter of type '(value: unknown) => any'.
  // Types of parameters 'rows' and 'value' are incompatible.
  //   Type 'unknown' is not assignable to type 'string | any[]'.
  //   Type 'unknown' is not assignable to type 'any[]'.ts(2345)
  // @ts-ignore
  return Conversation.getXidRecord(xid, zid).then((rows: string | any[]) => {
    if (!rows || !rows.length) {
      return "noXidRecord";
    }
    let xidRecordForPtpt = rows[0];
    if (xidRecordForPtpt) {
      return getPidPromise(zid, xidRecordForPtpt.uid, true).then(
        (pidForXid: any) => {
          xidRecordForPtpt.pid = pidForXid;
          return xidRecordForPtpt;
        }
      );
    }
    return xidRecordForPtpt;
  });
}

export {
  pidCache,
  getUserInfoForUid,
  getUserInfoForUid2,
  addLtiUserIfNeeded,
  addLtiContextMembership,
  renderLtiLinkageSuccessPage,
  getUser,
  createDummyUser,
  getPid,
  getPidPromise,
  getPidForParticipant,
  getSocialInfoForUsers,
};

export default {
  pidCache,
  getXidRecordByXidOwnerId,
  getXidStuff,
  getUserInfoForUid,
  getUserInfoForUid2,
  addLtiUserIfNeeded,
  addLtiContextMembership,
  renderLtiLinkageSuccessPage,
  getUser,
  createDummyUser,
  getPid,
  getPidPromise,
  getPidForParticipant,
  getSocialInfoForUsers,
};
