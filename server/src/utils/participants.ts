import { getPca } from "./pca";
import { ParticipantOption } from "../d";
import { queryP_readOnly as pgQueryP_readOnly } from "../db/pg-query";
import Config from "../config";

export function getBidIndexToPidMapping(zid: number, math_tick: number) {
  math_tick = math_tick || -1;
  return pgQueryP_readOnly(
    "select * from math_bidtopid where zid = ($1) and math_env = ($2);",
    [zid, Config.mathEnv]
    //     Argument of type '(rows: string | any[]) => any' is not assignable to parameter of type '(value: unknown) => any'.
    // Types of parameters 'rows' and 'value' are incompatible.
    //   Type 'unknown' is not assignable to type 'string | any[]'.
    //     Type 'unknown' is not assignable to type 'any[]'.ts(2345)
    // @ts-ignore
  ).then((rows: string | any[]) => {
    if (!rows || !rows.length) {
      // Could actually be a 404, would require more work to determine that.
      return new Error("polis_err_get_pca_results_missing");
    } else if (rows[0].data.math_tick <= math_tick) {
      return new Error("polis_err_get_pca_results_not_new");
    } else {
      return rows[0].data;
    }
  });
}

export function getPidsForGid(zid: any, gid: number, math_tick: number) {
  return Promise.all([
    getPca(zid, math_tick),
    getBidIndexToPidMapping(zid, math_tick),
  ]).then(function (o: ParticipantOption[]) {
    if (!o[0] || !o[0].asPOJO) {
      return [];
    }
    o[0] = o[0].asPOJO;
    let clusters = o[0]["group-clusters"];
    let indexToBid = o[0]["base-clusters"].id; // index to bid
    let bidToIndex = [];
    for (let i = 0; i < indexToBid.length; i++) {
      bidToIndex[indexToBid[i]] = i;
    }
    let indexToPids = o[1].bidToPid; // actually index to [pid]
    let cluster = clusters[gid];
    if (!cluster) {
      return [];
    }
    let members = cluster.members; // bids
    let pids: any[] = [];
    for (var i = 0; i < members.length; i++) {
      let bid = members[i];
      let index = bidToIndex[bid];
      let morePids = indexToPids[index];
      Array.prototype.push.apply(pids, morePids);
    }
    pids = pids.map(function (x) {
      return parseInt(x);
    });
    pids.sort(function (a, b) {
      return a - b;
    });
    return pids;
  });
}
