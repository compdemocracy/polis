import _ from "underscore";
import { failJson } from "../utils/fail";
import { getConversationInfo } from "../conversation";
import { isModerator, isPolisDev } from "../utils/common";
import { pullXInfoIntoSubObjects } from "../server-helpers";
import pg from "../db/pg-query";

function getSocialParticipantsForMod_timed(
  zid?: number,
  limit?: any,
  mod?: any,
  convOwner?: any
) {
  return getSocialParticipantsForMod
    .apply(null, [zid, limit, mod, convOwner])
    .then(function (results: any) {
      return results;
    });
}

function getSocialParticipantsForMod(
  zid: number,
  limit: any,
  mod: any,
  owner: any
) {
  let modClause = "";
  const params = [zid, limit, owner];
  if (!_.isUndefined(mod)) {
    modClause = " and mod = ($4)";
    params.push(mod);
  }

  const q =
    "with " +
    "p as (select uid, pid, mod from participants where zid = ($1) " +
    modClause +
    "), " + // and vote_count >= 1
    "final_set as (select * from p limit ($2)), " +
    "xids_subset as (select * from xids where owner = ($3) and x_profile_image_url is not null), " +
    "all_rows as (select " +
    // "final_set.priority, " +
    "final_set.mod, " +
    "xids_subset.x_profile_image_url as x_profile_image_url, " +
    "xids_subset.xid as xid, " +
    "xids_subset.x_name as x_name, " +
    "final_set.pid " +
    "from final_set " +
    "left join xids_subset on final_set.uid = xids_subset.uid " +
    ") " +
    "select * from all_rows where (xid is not null) " +
    ";";
  return pg.queryP(q, params);
}

function removeNullOrUndefinedProperties(o: { [x: string]: any }) {
  for (const k in o) {
    const v = o[k];
    if (v === null || v === undefined) {
      delete o[k];
    }
  }
  return o;
}

function handle_PUT_ptptois(
  req: { p: { zid: number; uid?: number; pid: number; mod: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const pid = req.p.pid;
  const mod = req.p.mod;
  isModerator(zid, uid)
    .then(function (isMod: any) {
      if (!isMod) {
        failJson(res, 403, "polis_err_ptptoi_permissions_123");
        return;
      }
      return pg
        .queryP(
          "update participants set mod = ($3) where zid = ($1) and pid = ($2);",
          [zid, pid, mod]
        )
        .then(function () {
          res.status(200).json({});
        });
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_ptptoi_misc_234", err);
    });
}

function handle_GET_ptptois(
  req: {
    p: { zid: number; mod: any; uid?: number; conversation_id: string };
  },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: any): void; new (): any };
    };
  }
) {
  const zid = req.p.zid;
  const mod = req.p.mod;
  const uid = req.p.uid;
  const limit = 99999;

  const convPromise = getConversationInfo(req.p.zid);
  const socialPtptsPromise = convPromise.then((conv: { owner: any }) => {
    return getSocialParticipantsForMod_timed(zid, limit, mod, conv.owner);
  });

  Promise.all([socialPtptsPromise, getConversationInfo(zid)])
    .then(function (a: any[]) {
      let ptptois = a[0];
      const conv = a[1];
      const isOwner = uid === conv.owner;
      const isAllowed = isOwner || isPolisDev(req.p.uid) || conv.is_data_open;
      if (isAllowed) {
        ptptois = ptptois.map(pullXInfoIntoSubObjects);
        ptptois = ptptois.map(removeNullOrUndefinedProperties);
        ptptois = ptptois.map(function (p: { conversation_id: any }) {
          p.conversation_id = req.p.conversation_id;
          return p;
        });
      } else {
        ptptois = [];
      }
      res.status(200).json(ptptois);
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_ptptoi_misc", err);
    });
}

export { handle_GET_ptptois, handle_PUT_ptptois };
