import { getPca } from "./pca";
import { ParticipantOption } from "../d";
import pg from "../db/pg-query";
import Config from "../config";

export function getBidIndexToPidMapping(zid: number, math_tick: number) {
  math_tick = math_tick || -1;
  return pg
    .queryP_readOnly(
      "select * from math_bidtopid where zid = ($1) and math_env = ($2);",
      [zid, Config.mathEnv]
    )
    .then((rows: string | any[]) => {
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

export function getPidsForGid(zid: number, gid: number, math_tick: number) {
  return Promise.all([
    getPca(zid, math_tick),
    getBidIndexToPidMapping(zid, math_tick),
  ]).then(function (o: ParticipantOption[]) {
    if (!o[0] || !o[0].asPOJO) {
      return [];
    }
    o[0] = o[0].asPOJO;
    const clusters = o[0]["group-clusters"];
    const indexToBid = o[0]["base-clusters"].id; // index to bid
    const bidToIndex = [];
    for (let i = 0; i < indexToBid.length; i++) {
      bidToIndex[indexToBid[i]] = i;
    }
    const indexToPids = o[1].bidToPid; // actually index to [pid]
    const cluster = clusters[gid];
    if (!cluster) {
      return [];
    }
    const members = cluster.members; // bids
    let pids: any[] = [];
    for (let i = 0; i < members.length; i++) {
      const bid = members[i];
      const index = bidToIndex[bid];
      const morePids = indexToPids ? indexToPids[index] : null;
      if (morePids) Array.prototype.push.apply(pids, morePids);
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
