// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import zlib, { InputType } from "zlib";
import _ from "underscore";
import LruCache from "lru-cache";
import { queryP_readOnly as pgQueryP_readOnly } from "../db/pg-query";
import Config from "../config";
import logger from "./logger";
import { addInRamMetric } from "./metered";

export type PcaCacheItem = {
  asPOJO: any;
  consensus: { agree?: any; disagree?: any };
  repness: { [x: string]: any };
  asJSON: string;
  asBufferOfGzippedJson: any;
  expiration: number;
};
let pcaCacheSize = Config.cacheMathResults ? 300 : 1;
let pcaCache = new LruCache<number, PcaCacheItem>({
  max: pcaCacheSize,
});

let lastPrefetchedMathTick = -1;

// this scheme might not last forever. For now, there are only a couple of MB worth of conversation pca data.
export function fetchAndCacheLatestPcaData() {
  let lastPrefetchPollStartTime = Date.now();

  function waitTime() {
    let timePassed = Date.now() - lastPrefetchPollStartTime;
    return Math.max(0, 2500 - timePassed);
  }
  // cursor.sort([["math_tick", "asc"]]);
  pgQueryP_readOnly(
    "select * from math_main where caching_tick > ($1) order by caching_tick limit 10;",
    [lastPrefetchedMathTick]
  )
    // Argument of type '(rows: any[]) => void' is not assignable to parameter of type '(value: unknown) => void | PromiseLike<void>'.
    // Types of parameters 'rows' and 'value' are incompatible.
    //     Type 'unknown' is not assignable to type 'any[]'.ts(2345)
    // @ts-ignore
    .then((rows: any[]) => {
      if (!rows || !rows.length) {
        // call again
        logger.info("mathpoll done");
        setTimeout(fetchAndCacheLatestPcaData, waitTime());
        return;
      }

      let results = rows.map(
        (row: { data: any; math_tick: any; caching_tick: any }) => {
          let item = row.data;

          if (row.math_tick) {
            item.math_tick = Number(row.math_tick);
          }
          if (row.caching_tick) {
            item.caching_tick = Number(row.caching_tick);
          }

          logger.info("mathpoll updating", {
            caching_tick: item.caching_tick,
            zid: item.zid,
          });

          // let prev = pcaCache.get(item.zid);
          if (item.caching_tick > lastPrefetchedMathTick) {
            lastPrefetchedMathTick = item.caching_tick;
          }

          processMathObject(item);

          return updatePcaCache(item.zid, item);
        }
      );
      Promise.all(results).then((a: any) => {
        setTimeout(fetchAndCacheLatestPcaData, waitTime());
      });
    })
    .catch((err: any) => {
      logger.error("mathpoll error", err);
      setTimeout(fetchAndCacheLatestPcaData, waitTime());
    });
}

export function getPca(
  zid?: any,
  math_tick?: number
): Promise<PcaCacheItem | undefined> {
  let cached = pcaCache.get(zid);
  // Object is of type 'unknown'.ts(2571)
  // @ts-ignore
  if (cached && cached.expiration < Date.now()) {
    cached = undefined;
  }
  // Object is of type 'unknown'.ts(2571)
  // @ts-ignore
  let cachedPOJO = cached && cached.asPOJO;
  if (cachedPOJO) {
    if (cachedPOJO.math_tick <= (math_tick || 0)) {
      logger.info("math was cached but not new", {
        zid,
        cached_math_tick: cachedPOJO.math_tick,
        query_math_tick: math_tick,
      });
      return Promise.resolve(undefined);
    } else {
      logger.info("math from cache", { zid, math_tick });
      return Promise.resolve(cached);
    }
  }

  logger.info("mathpoll cache miss", { zid, math_tick });

  // NOTE: not caching results from this query for now, think about this later.
  // not caching these means that conversations without new votes might not be cached. (closed conversations may be slower to load)
  // It's probably not difficult to cache, but keeping things simple for now, and only caching things that come down with the poll.

  let queryStart = Date.now();

  return pgQueryP_readOnly(
    "select * from math_main where zid = ($1) and math_env = ($2);",
    [zid, Config.mathEnv]
    //     Argument of type '(rows: string | any[]) => Promise<any> | null' is not assignable to parameter of type '(value: unknown) => any'.
    // Types of parameters 'rows' and 'value' are incompatible.
    //   Type 'unknown' is not assignable to type 'string | any[]'.
    //     Type 'unknown' is not assignable to type 'any[]'.ts(2345)
    // @ts-ignore
  ).then((rows: string | any[]) => {
    let queryEnd = Date.now();
    let queryDuration = queryEnd - queryStart;
    addInRamMetric("pcaGetQuery", queryDuration);

    if (!rows || !rows.length) {
      logger.info(
        "mathpoll related; after cache miss, unable to find data for",
        {
          zid,
          math_tick,
          math_env: Config.mathEnv,
        }
      );
      return undefined;
    }
    let item = rows[0].data;

    if (rows[0].math_tick) {
      item.math_tick = Number(rows[0].math_tick);
    }

    if (item.math_tick <= (math_tick || 0)) {
      logger.info("after cache miss, unable to find newer item", {
        zid,
        math_tick,
      });
      return undefined;
    }
    logger.info("after cache miss, found item, adding to cache", {
      zid,
      math_tick,
    });

    processMathObject(item);

    return updatePcaCache(zid, item);
  });
}

function updatePcaCache(zid: any, item: { zid: any }): Promise<PcaCacheItem> {
  return new Promise(function (
    resolve: (arg0: PcaCacheItem) => void,
    reject: (arg0: any) => any
  ) {
    delete item.zid; // don't leak zid
    let asJSON = JSON.stringify(item);
    let buf = Buffer.from(asJSON, "utf-8");
    zlib.gzip(buf as unknown as InputType, function (err: any, jsondGzipdPcaBuffer: any) {
      if (err) {
        return reject(err);
      }

      let o = {
        asPOJO: item,
        asJSON: asJSON,
        asBufferOfGzippedJson: jsondGzipdPcaBuffer,
        expiration: Date.now() + 3000,
      } as PcaCacheItem;
      // save in LRU cache, but don't update the lastPrefetchedMathTick
      pcaCache.set(zid, o);
      resolve(o);
    });
  });
}

function processMathObject(o: { [x: string]: any }) {
  function remapSubgroupStuff(g: { val: any[] }) {
    if (_.isArray(g.val)) {
      g.val = g.val.map((x: { id: number }) => {
        return { id: Number(x.id), val: x };
      });
    } else {
      // Argument of type '(id: number) => { id: number; val: any; }'
      // is not assignable to parameter of type '(value: string, index: number, array: string[]) => { id: number; val: any; }'.
      // Types of parameters 'id' and 'value' are incompatible.
      //         Type 'string' is not assignable to type 'number'.ts(2345)
      // @ts-ignore
      g.val = _.keys(g.val).map((id: number) => {
        return { id: Number(id), val: g.val[id] };
      });
    }
    return g;
  }

  // Normalize so everything is arrays of objects (group-clusters is already in this format, but needs to have the val: subobject style too).

  if (_.isArray(o["group-clusters"])) {
    // NOTE this is different since group-clusters is already an array.
    o["group-clusters"] = o["group-clusters"].map((g: { id: any }) => {
      return { id: Number(g.id), val: g };
    });
  }

  if (!_.isArray(o["repness"])) {
    o["repness"] = _.keys(o["repness"]).map((gid: string | number) => {
      return { id: Number(gid), val: o["repness"][gid] };
    });
  }
  if (!_.isArray(o["group-votes"])) {
    o["group-votes"] = _.keys(o["group-votes"]).map((gid: string | number) => {
      return { id: Number(gid), val: o["group-votes"][gid] };
    });
  }
  if (!_.isArray(o["subgroup-repness"])) {
    o["subgroup-repness"] = _.keys(o["subgroup-repness"]).map(
      (gid: string | number) => {
        return { id: Number(gid), val: o["subgroup-repness"][gid] };
      }
    );
    o["subgroup-repness"].map(remapSubgroupStuff);
  }
  if (!_.isArray(o["subgroup-votes"])) {
    o["subgroup-votes"] = _.keys(o["subgroup-votes"]).map(
      (gid: string | number) => {
        return { id: Number(gid), val: o["subgroup-votes"][gid] };
      }
    );
    o["subgroup-votes"].map(remapSubgroupStuff);
  }
  if (!_.isArray(o["subgroup-clusters"])) {
    o["subgroup-clusters"] = _.keys(o["subgroup-clusters"]).map(
      (gid: string | number) => {
        return { id: Number(gid), val: o["subgroup-clusters"][gid] };
      }
    );
    o["subgroup-clusters"].map(remapSubgroupStuff);
  }

  // Edge case where there are two groups and one is huge, split the large group.
  // Once we have a better story for h-clust in the participation view, then we can just show the h-clust instead.
  // var groupVotes = o['group-votes'];
  // if (_.keys(groupVotes).length === 2 && o['subgroup-votes'] && o['subgroup-clusters'] && o['subgroup-repness']) {
  //   var s0 = groupVotes[0].val['n-members'];
  //   var s1 = groupVotes[1].val['n-members'];
  //   const scaleRatio = 1.1;
  //   if (s1 * scaleRatio < s0) {
  //     o = splitTopLevelGroup(o, groupVotes[0].id);
  //   } else if (s0 * scaleRatio < s1) {
  //     o = splitTopLevelGroup(o, groupVotes[1].id);
  //   }
  // }

  // // Gaps in the gids are not what we want to show users, and they make client development difficult.
  // // So this guarantees that the gids are contiguous. TODO look into Darwin.
  // o = packGids(o);

  // Un-normalize to maintain API consistency.
  // This could removed in a future API version.
  function toObj(a: string | any[]) {
    let obj = {};
    if (!a) {
      return obj;
    }
    for (let i = 0; i < a.length; i++) {
      // Element implicitly has an 'any' type
      // because expression of type 'any' can't be used to index type '{ } '.ts(7053)
      // @ts-ignore
      obj[a[i].id] = a[i].val;
      // Element implicitly has an 'any' type
      // because expression of type 'any' can't be used to index type '{ } '.ts(7053)
      // @ts-ignore
      obj[a[i].id].id = a[i].id;
    }
    return obj;
  }
  function toArray(a: any[]) {
    if (!a) {
      return [];
    }
    return a.map((g: { id: any; val: any }) => {
      let id = g.id;
      g = g.val;
      g.id = id;
      return g;
    });
  }
  o["repness"] = toObj(o["repness"]);
  o["group-votes"] = toObj(o["group-votes"]);
  o["group-clusters"] = toArray(o["group-clusters"]);

  delete o["subgroup-repness"];
  delete o["subgroup-votes"];
  delete o["subgroup-clusters"];
  return o;
}
