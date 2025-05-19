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
  asPOJO: {
    "group-clusters": Array<{
      id: number;
      center: number[];
      members: number[]; // These are base cluster IDs, not participant IDs
    }>;
    "base-clusters": {
      x: number[];
      y: number[];
      id: number[];
      count: number[];
      members: number[][]; // Array of arrays, each inner array contains participant IDs
      [key: string]: any;
    };
    "group-votes"?: Record<string, {
      votes: Record<string, {
        A: number; // agrees
        D: number; // disagrees
        S: number; // sum of all votes
      }>
    }>;
    "group-aware-consensus"?: Record<string, number>;
    "user-vote-counts": Record<string, number>;
    "in-conv": number[];
    "n-cmts": number;
    pca: {
      comps: number[][]; // [dimensions][participants]
      center: number[];
      "comment-extremity": number[];
      "comment-projection": any;
    };
    tids?: number[];
    n: number;
    "mod-in"?: number[];
    "mod-out"?: number[];
    repness: Record<string, any[]>;
    consensus: {
      agree: any[];
      disagree: any[];
    };
    "meta-tids"?: number[];
    "votes-base"?: Record<string, any>;
    "lastModTimestamp"?: number | null;
    "lastVoteTimestamp"?: number;
    "comment-priorities"?: Record<string, number>;
    "math_tick": number;
    [key: string]: any;
  };
  consensus: { agree?: any; disagree?: any };
  repness: { [x: string]: any };
  asJSON: string;
  asBufferOfGzippedJson: any;
  expiration: number;
};

const pcaCacheSize = Config.cacheMathResults ? 300 : 1;
const pcaCache = new LruCache<number, PcaCacheItem>({
  max: pcaCacheSize,
});

// this scheme might not last forever. For now, there are only a couple of MB worth of conversation pca data.
let lastPrefetchedMathTick = -1;

// Background polling function to proactively cache PCA data
export function fetchAndCacheLatestPcaData() {
  let lastPrefetchPollStartTime = Date.now();

  function waitTime() {
    const timePassed = Date.now() - lastPrefetchPollStartTime;
    return Math.max(0, 2500 - timePassed);
  }

  function pollForLatestPcaData() {
    lastPrefetchPollStartTime = Date.now();
    
    pgQueryP_readOnly<Array<{ data: any; math_tick: any; caching_tick: any; zid: any }>>(
      "select * from math_main where caching_tick > ($1) order by caching_tick limit 10;",
      [lastPrefetchedMathTick]
    ).then((rows) => {
      const rowsArray = rows as Array<{ data: any; math_tick: any; caching_tick: any; zid: any }>;
      
      if (!rowsArray || !rowsArray.length) {
        // call again
        logger.info("mathpoll done");
        setTimeout(pollForLatestPcaData, waitTime());
        return;
      }

      const results = rowsArray.map(row => {
        const item = row.data;

        if (row.math_tick) {
          item.math_tick = Number(row.math_tick);
        }
        if (row.caching_tick) {
          item.caching_tick = Number(row.caching_tick);
        }

        logger.info("mathpoll updating", {
          caching_tick: item.caching_tick,
          zid: row.zid,
        });

        if (item.caching_tick > lastPrefetchedMathTick) {
          lastPrefetchedMathTick = item.caching_tick;
        }

        processMathObject(item);

        return updatePcaCache(row.zid, item);
      });
      
      Promise.all(results).then(() => {
        setTimeout(pollForLatestPcaData, waitTime());
      });
    }).catch((err) => {
      logger.error("mathpoll error", err);
      setTimeout(pollForLatestPcaData, waitTime());
    });
  }

  // Start the polling process
  pollForLatestPcaData();
}

export function getPca(
  zid?: any,
  math_tick?: number
): Promise<PcaCacheItem | undefined> {
  let cached = pcaCache.get(zid);
  if (cached && cached.expiration < Date.now()) {
    cached = undefined;
  }
  const cachedPOJO = cached && cached.asPOJO;
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

  const queryStart = Date.now();

  return pgQueryP_readOnly<Array<{ data: any; math_tick: any }>>(
    "select * from math_main where zid = ($1) and math_env = ($2);",
    [zid, Config.mathEnv]
  ).then((rows) => {
    const queryEnd = Date.now();
    const queryDuration = queryEnd - queryStart;
    addInRamMetric("pcaGetQuery", queryDuration);

    // Ensure rows is an array with proper type assertion
    const rowsArray = rows as Array<{ data: any; math_tick: any }>;
    
    if (!rowsArray || !rowsArray.length) {
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
    const item = rowsArray[0].data;

    if (rowsArray[0].math_tick) {
      item.math_tick = Number(rowsArray[0].math_tick);
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
    const asJSON = JSON.stringify(item);
    const buf = Buffer.from(asJSON, "utf-8");
    zlib.gzip(buf as unknown as InputType, function (err: any, jsondGzipdPcaBuffer: any) {
      if (err) {
        return reject(err);
      }

      const o = {
        asPOJO: item,
        asJSON: asJSON,
        asBufferOfGzippedJson: jsondGzipdPcaBuffer,
        expiration: Date.now() + 3000,
        consensus: (item as any).consensus || { agree: {}, disagree: {} },
        repness: (item as any).repness || {},
      } as unknown as PcaCacheItem;
      // save in LRU cache, but don't update the lastPrefetchedMathTick
      pcaCache.set(zid, o);
      resolve(o);
    });
  });
}

function processMathObject(o: { [x: string]: any }) {
  function remapSubgroupStuff(o: any) {
    if (!o) {
      return o;
    }
    
    // Helper function to safely map arrays or convert objects to arrays
    function safeMap(input: any, mapFn: (item: any, index: number) => any): any[] {
      if (Array.isArray(input)) {
        return input.map(mapFn);
      } else if (input && typeof input === 'object') {
        return Object.keys(input).map((key) => mapFn(input[key], Number(key)));
      }
      return [];
    }

    // Process all subgroup properties in a single loop
    const subgroupProperties = [
      "group-clusters", "repness", "group-votes", 
      "subgroup-repness", "subgroup-votes", "subgroup-clusters"
    ];
    
    subgroupProperties.forEach(prop => {
      if (o[prop]) {
        o[prop] = safeMap(o[prop], (val, i) => ({
          id: Number(i),
          val: val
        }));
      }
    });

    return o;
  }

  // Normalize so everything is arrays of objects (group-clusters is already in this format, but needs to have the val: subobject style too).
  if (_.isArray(o["group-clusters"])) {
    // NOTE this is different since group-clusters is already an array.
    o["group-clusters"] = o["group-clusters"].map((g: { id: any }) => {
      return { id: Number(g.id), val: g };
    });
  }

  // Process all non-array properties that need to be converted to arrays
  const propsToConvert = [
    "repness", "group-votes", "subgroup-repness", 
    "subgroup-votes", "subgroup-clusters"
  ];
  
  propsToConvert.forEach(prop => {
    if (!_.isArray(o[prop])) {
      o[prop] = _.keys(o[prop]).map((gid: string) => ({
        id: Number(gid), 
        val: o[prop][gid]
      }));
      
      // Apply remapSubgroupStuff to subgroup properties
      if (prop.startsWith("subgroup-")) {
        o[prop].map(remapSubgroupStuff);
      }
    }
  });

  // Un-normalize to maintain API consistency.
  // This could removed in a future API version.
  function toObj(a: any[] | undefined): Record<string, any> {
    const obj: Record<string, any> = {};
    if (!a) {
      return obj;
    }
    for (let i = 0; i < a.length; i++) {
      obj[a[i].id] = a[i].val;
      obj[a[i].id].id = a[i].id;
    }
    return obj;
  }
  function toArray(a: any[]) {
    if (!a) {
      return [];
    }
    return a.map((g: { id: any; val: any }) => {
      const id = g.id;
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
