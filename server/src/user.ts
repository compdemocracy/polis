import _ from "underscore";
import LruCache from "lru-cache";

import { getXidRecord } from "./xids";
import { UserInfo, XidRecord } from "./d";
import logger from "./utils/logger";
import pg from "./db/pg-query";

interface UserResponse {
  uid: number;
  email?: string;
  hname?: string;
  hasXid: boolean;
  xInfo?: any;
  finishedTutorial: boolean;
  site_ids: number[];
  created: number;
}

const pidCache: LruCache<string, number> = new LruCache({
  max: 9000,
});

async function getUserInfoForUid2(uid: number): Promise<UserInfo> {
  return new Promise((resolve, reject) => {
    pg.query_readOnly(
      "SELECT * from users where uid = $1",
      [uid],
      function (err: any, results: { rows: UserInfo[] }) {
        if (err) {
          logger.error("getUserInfoForUid");
          return reject(err);
        }
        if (!results.rows || !results.rows.length) {
          return reject(new Error("User not found"));
        }
        resolve(results.rows[0]);
      }
    );
  });
}

async function getUser(
  uid: number,
  zid_optional?: number,
  xid_optional?: string,
  owner_uid_optional?: number
): Promise<UserResponse | object> {
  if (!uid) {
    // this api may be called by a new user, so we don't want to trigger a failure here.
    return {};
  }

  let XidRecordPromise: Promise<XidRecord[]> = Promise.resolve([]);

  // Look up XID record if xid and either zid or owner is available
  // The function will prefer zid-based lookup if both are provided
  if (xid_optional && (zid_optional || owner_uid_optional)) {
    XidRecordPromise = getXidRecord(
      xid_optional,
      zid_optional,
      owner_uid_optional
    );
  }

  const [info, xInfo] = await Promise.all([
    getUserInfoForUid2(uid),
    XidRecordPromise,
  ]);

  const hasXid = xInfo && xInfo.length && xInfo[0];

  if (hasXid) {
    delete xInfo[0].owner;
    delete xInfo[0].created;
  }

  return {
    uid: uid,
    email: info.email,
    hname: info.hname,
    hasXid: !!hasXid,
    xInfo: xInfo && xInfo[0],
    finishedTutorial: !!info.tut,
    site_ids: [info.site_id],
    created: Number(info.created),
  };
}

// returns a pid of -1 if it's missing
function getPid(
  zid: number,
  uid: number,
  callback: (err: any, pid: number) => void
): void {
  const cacheKey = zid + "_" + uid;
  const cachedPid = pidCache.get(cacheKey);
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
async function getPidPromise(
  zid: number,
  uid: number,
  usePrimary?: boolean
): Promise<number> {
  const cacheKey = zid + "_" + uid;
  const cachedPid = pidCache.get(cacheKey);

  if (!_.isUndefined(cachedPid)) {
    return cachedPid;
  }

  return new Promise((resolve, reject) => {
    const queryFunction = usePrimary ? pg.query : pg.query_readOnly;
    queryFunction(
      "SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);",
      [zid, uid],
      function (err: any, results: { rows: { pid: number }[] }) {
        if (err) {
          logger.error("getPidPromise query error", {
            zid: zid,
            uid: uid,
            error: err,
          });
          return reject(err);
        }
        if (!results || !results.rows || !results.rows.length) {
          resolve(-1);
          return;
        }
        const pid = results.rows[0].pid;
        pidCache.set(cacheKey, pid);
        resolve(pid);
      }
    );
  });
}

// must follow auth and need('zid'...) middleware
function getPidForParticipant(
  assigner: (req: any, key: string, value: any) => void
) {
  return function (
    req: { p: { zid: string; uid: string } },
    res: any,
    next: (err?: string) => void
  ) {
    const zid = Number(req.p.zid);
    const uid = Number(req.p.uid);

    function finish(pid: number) {
      assigner(req, "pid", pid);
      next();
    }

    getPidPromise(zid, uid).then(
      function (pid: number) {
        if (pid === -1) {
          const msg = "polis_err_get_pid_for_participant_missing";
          logger.error(msg, {
            zid,
            uid,
            p: req.p,
          });
          next(msg);
          return;
        }
        finish(pid);
      },
      function (err: any) {
        logger.error("polis_err_get_pid_for_participant", err);
        next(err);
      }
    );
  };
}

export {
  getPid,
  getPidForParticipant,
  getPidPromise,
  getUser,
  getUserInfoForUid2,
};
