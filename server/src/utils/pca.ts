// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import zlib, { InputType } from "zlib";
import _ from "underscore";
import LruCache from "lru-cache";
import pg from "../db/pg-query";
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
    "group-votes"?: Record<
      string,
      {
        votes: Record<
          string,
          {
            A: number; // agrees
            D: number; // disagrees
            S: number; // sum of all votes
          }
        >;
      }
    >;
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
    lastModTimestamp?: number | null;
    lastVoteTimestamp?: number;
    "comment-priorities"?: Record<string, number>;
    math_tick: number;
    [key: string]: any;
  };
  consensus: { agree?: any; disagree?: any };
  repness: { [x: string]: any };
  asJSON: string;
  asBufferOfGzippedJson: any;
  expiration: number;
};

const pcaCacheSize = Config.cacheMathResults ? 300 : 1;
const pcaCache = new LruCache<string, PcaCacheItem>({
  max: pcaCacheSize,
});

/**
 * Cache entries that are `createEmptyPcaStructure`'s synthesized empty
 * presentation for a conversation with NO committed math row, rather than a
 * generation read from `math_main`.
 *
 * Provenance has to be carried, not inferred: a real published generation can
 * legitimately be empty (tick 0, n 0, empty arrays), and such a row must stay
 * returnable and cacheable.
 *
 * It is held OUTSIDE the entry, in a WeakSet keyed by entry identity, because
 * `handle_GET_participationInit` assigns the whole cache entry to
 * `response.pca` and serializes it (routes/participation.ts:393,450). Any
 * enumerable property added here would go out on the wire for every tick,
 * including tick 1 — a served-bytes change. Keeping asPOJO/asJSON/the gzip body
 * clean is not enough; the wrapper is served too. A WeakSet cannot be
 * serialized and drops entries with the cache.
 */
const synthesizedEntries = new WeakSet<PcaCacheItem>();

// Each namespace has an independent publication cursor and cache entries.
const lastPrefetchedMathTicks = new Map<string, number>();

function pcaCacheKey(mathEnv: string, zid: number): string {
  return JSON.stringify([mathEnv, zid]);
}

// One batch, shared by the background loop and integration tests. Capture the
// namespace before any async work so a config change cannot relabel its results.
export async function prefetchLatestPcaData(): Promise<void> {
  const mathEnv = Config.mathEnv;
  let lastPrefetchedMathTick = lastPrefetchedMathTicks.get(mathEnv) ?? -1;
  const rows = await pg.queryP_readOnly<
    Array<{ data: any; math_tick: any; caching_tick: any; zid: number }>
  >(
    "select * from math_main where caching_tick > ($1) and math_env = ($2) order by caching_tick limit 10;",
    [lastPrefetchedMathTick, mathEnv]
  );

  await Promise.all(
    (
      rows as Array<{
        data: any;
        math_tick: any;
        caching_tick: any;
        zid: number;
      }>
    ).map((row) => {
      const item = row.data;
      // `!= null`, not truthiness: generation 0 is a real committed tick (see
      // getPca below), and the blob's own `math_tick` is an engine-local value
      // that must never win over the column.
      if (row.math_tick != null) {
        item.math_tick = Number(row.math_tick);
      }
      if (row.caching_tick != null) {
        item.caching_tick = Number(row.caching_tick);
      }
      logger.info("mathpoll updating", {
        caching_tick: item.caching_tick,
        zid: row.zid,
      });
      lastPrefetchedMathTick = Math.max(
        lastPrefetchedMathTick,
        Number(row.caching_tick)
      );
      processMathObject(item);
      return updatePcaCache(mathEnv, row.zid, item);
    })
  );
  lastPrefetchedMathTicks.set(
    mathEnv,
    Math.max(lastPrefetchedMathTicks.get(mathEnv) ?? -1, lastPrefetchedMathTick)
  );
}

// Background polling function to proactively cache PCA data
export function fetchAndCacheLatestPcaData() {
  async function pollForLatestPcaData() {
    const pollStart = Date.now();
    try {
      await prefetchLatestPcaData();
    } catch (err) {
      logger.error("mathpoll error", err);
    }
    setTimeout(
      pollForLatestPcaData,
      Math.max(0, 2500 - (Date.now() - pollStart))
    );
  }

  // Start the polling process
  pollForLatestPcaData();
}

/**
 * Creates a minimal valid PCA structure for conversations with no votes.
 * This allows reports to load and display properly even when there's no voting data.
 */
async function createEmptyPcaStructure(
  zid: number
): Promise<PcaCacheItem["asPOJO"]> {
  // Fetch comment IDs if they exist
  let tids: number[] = [];
  let nCmts = 0;

  try {
    const commentsQuery = await pg.queryP_readOnly<Array<{ tid: number }>>(
      "select tid from comments where zid = ($1) and mod >= 1 order by tid",
      [zid]
    );

    if (commentsQuery && Array.isArray(commentsQuery)) {
      tids = commentsQuery.map((row: { tid: number }) => row.tid);
      nCmts = tids.length;
    }
  } catch (err) {
    logger.error("Error fetching comments for empty PCA structure", err);
  }

  return {
    "group-clusters": [],
    "base-clusters": {
      x: [],
      y: [],
      id: [],
      count: [],
      members: [],
    },
    "group-votes": {},
    "group-aware-consensus": {},
    "user-vote-counts": {},
    "in-conv": [],
    "n-cmts": nCmts,
    pca: {
      comps: [[], []],
      center: [0, 0],
      "comment-extremity": tids.map(() => 0), // Initialize with zeros for each comment
      "comment-projection": {},
    },
    tids: tids,
    n: 0,
    repness: {},
    consensus: {
      agree: [],
      disagree: [],
    },
    "votes-base": {},
    lastModTimestamp: null,
    lastVoteTimestamp: Date.now(),
    "comment-priorities": {},
    math_tick: 0,
  };
}

/**
 * Ensures all required PCA fields exist by merging incomplete data with empty structure
 * This prevents client failures when PCA data exists but is missing required fields
 */
async function ensureCompletePcaStructure(
  zid: number,
  existingData?: any
): Promise<PcaCacheItem["asPOJO"]> {
  const emptyStructure = await createEmptyPcaStructure(zid);

  if (!existingData) {
    return emptyStructure;
  }

  // Merge existing data with empty structure, ensuring all required fields exist
  const mergedData = {
    ...emptyStructure,
    ...existingData,
    // Ensure nested objects are properly merged
    pca: {
      ...emptyStructure.pca,
      ...existingData.pca,
    },
    consensus: {
      ...emptyStructure.consensus,
      ...existingData.consensus,
    },
    "base-clusters": {
      ...emptyStructure["base-clusters"],
      ...existingData["base-clusters"],
    },
  };

  // Ensure arrays exist even if they're empty
  if (!Array.isArray(mergedData["group-clusters"])) {
    mergedData["group-clusters"] = emptyStructure["group-clusters"];
  }
  if (!Array.isArray(mergedData["in-conv"])) {
    mergedData["in-conv"] = emptyStructure["in-conv"];
  }
  if (!Array.isArray(mergedData.tids)) {
    mergedData.tids = emptyStructure.tids;
  }
  if (!Array.isArray(mergedData["mod-in"])) {
    mergedData["mod-in"] = emptyStructure["mod-in"] || [];
  }
  if (!Array.isArray(mergedData["mod-out"])) {
    mergedData["mod-out"] = emptyStructure["mod-out"] || [];
  }
  if (!Array.isArray(mergedData["meta-tids"])) {
    mergedData["meta-tids"] = emptyStructure["meta-tids"] || [];
  }

  // Ensure objects exist even if they're empty
  if (
    !mergedData["group-votes"] ||
    typeof mergedData["group-votes"] !== "object"
  ) {
    mergedData["group-votes"] = emptyStructure["group-votes"];
  }
  if (
    !mergedData["group-aware-consensus"] ||
    typeof mergedData["group-aware-consensus"] !== "object"
  ) {
    mergedData["group-aware-consensus"] =
      emptyStructure["group-aware-consensus"];
  }
  if (
    !mergedData["user-vote-counts"] ||
    typeof mergedData["user-vote-counts"] !== "object"
  ) {
    mergedData["user-vote-counts"] = emptyStructure["user-vote-counts"];
  }
  if (!mergedData.repness || typeof mergedData.repness !== "object") {
    mergedData.repness = emptyStructure.repness;
  }
  if (
    !mergedData["votes-base"] ||
    typeof mergedData["votes-base"] !== "object"
  ) {
    mergedData["votes-base"] = emptyStructure["votes-base"];
  }
  if (
    !mergedData["comment-priorities"] ||
    typeof mergedData["comment-priorities"] !== "object"
  ) {
    mergedData["comment-priorities"] = emptyStructure["comment-priorities"];
  }

  // Ensure required numeric fields exist
  if (typeof mergedData.n !== "number") {
    mergedData.n = emptyStructure.n;
  }
  if (typeof mergedData["n-cmts"] !== "number") {
    mergedData["n-cmts"] = emptyStructure["n-cmts"];
  }
  if (typeof mergedData.math_tick !== "number") {
    mergedData.math_tick = existingData.math_tick || emptyStructure.math_tick;
  }
  if (typeof mergedData.lastVoteTimestamp !== "number") {
    mergedData.lastVoteTimestamp =
      existingData.lastVoteTimestamp || emptyStructure.lastVoteTimestamp;
  }

  return mergedData;
}

export type GetPcaOptions = {
  /**
   * When a conversation has no `math_main` row at all, `getPca` synthesizes an
   * empty presentation (`createEmptyPcaStructure`) for "latest" callers so
   * reports still render. That synthesis costs a second query against
   * `comments`.
   *
   * Internal callers that only want real math — comment routing, featured
   * authors — set this false: they get the latest committed generation when one
   * exists, and `undefined` after exactly one query when none does. Defaults to
   * true, which is every pre-existing caller's behaviour.
   */
  synthesizeEmptyWhenMissing?: boolean;
};

/**
 * The latest committed math generation for a conversation, or `undefined` when
 * the conversation has no math row at all.
 *
 * Use this instead of the literal `getPca(zid, 0)`, which asks for a generation
 * strictly newer than 0 and therefore silently discards a conversation's *first*
 * committed generation — `math_ticks.math_tick` is `NOT NULL DEFAULT 0`, so
 * generation 0 is real math with real `comment-priorities` and a real consensus.
 *
 * Unlike `getPca(zid)` this never synthesizes an empty presentation, so the
 * no-math-row path stays at one query.
 */
export function getLatestExistingPca(
  zid: number
): Promise<PcaCacheItem | undefined> {
  return getPca(zid, -1, { synthesizeEmptyWhenMissing: false });
}

export function getPca(
  zid?: number,
  math_tick?: number,
  options?: GetPcaOptions
): Promise<PcaCacheItem | undefined> {
  const synthesizeEmptyWhenMissing =
    options?.synthesizeEmptyWhenMissing !== false;
  const mathEnv = Config.mathEnv;
  let cached = pcaCache.get(pcaCacheKey(mathEnv, zid));
  if (cached && cached.expiration < Date.now()) {
    cached = undefined;
  }
  // The [math_env, zid] cache is shared by every caller, so an entry may have
  // been put there by an ordinary read that SYNTHESIZED an empty presentation
  // for a conversation with no committed row. That is not an answer for a
  // caller that asked for existing math only, and the provenance cannot be
  // recovered by inspecting the payload -- a real published generation 0 can be
  // legitimately empty. So the entry carries a `synthesized` flag and the
  // existing-only path reads the store instead.
  //
  // Bypass, not evict: ordinary readers still want that entry, and dropping it
  // would change their query pattern. Row-backed entries are always usable.
  if (cached && !synthesizeEmptyWhenMissing && synthesizedEntries.has(cached)) {
    logger.silly("mathpoll bypassing synthesized cache entry", { zid });
    cached = undefined;
  }
  const cachedPOJO = cached && cached.asPOJO;
  if (cachedPOJO) {
    // When caller wants the latest data (math_tick undefined or -1), return cached data
    // This includes empty structures (math_tick: 0) created when no math data exists
    if (math_tick === undefined || math_tick === -1) {
      logger.silly("math from cache (latest requested)", { zid, math_tick });
      return Promise.resolve(cached);
    }
    // When caller specifies a math_tick, only return cached data if it's newer
    if (cachedPOJO.math_tick <= math_tick) {
      logger.info("math was cached but not new", {
        zid,
        cached_math_tick: cachedPOJO.math_tick,
        query_math_tick: math_tick,
      });
      return Promise.resolve(undefined);
    } else {
      logger.silly("math from cache", { zid, math_tick });
      return Promise.resolve(cached);
    }
  }

  logger.silly("mathpoll cache miss", { zid, math_tick });

  // NOTE: not caching results from this query for now, think about this later.
  // not caching these means that conversations without new votes might not be cached. (closed conversations may be slower to load)
  // It's probably not difficult to cache, but keeping things simple for now, and only caching things that come down with the poll.

  const queryStart = Date.now();

  return pg
    .queryP_readOnly<Array<{ data: any; math_tick: any }>>(
      "select * from math_main where zid = ($1) and math_env = ($2);",
      [zid, mathEnv]
    )
    .then((rows) => {
      const queryEnd = Date.now();
      const queryDuration = queryEnd - queryStart;
      addInRamMetric("pcaGetQuery", queryDuration);

      // Ensure rows is an array with proper type assertion
      const rowsArray = rows as Array<{ data: any; math_tick: any }>;

      if (!rowsArray || !rowsArray.length) {
        logger.silly(
          "mathpoll related; after cache miss, unable to find data for",
          {
            zid,
            math_tick,
            math_env: mathEnv,
          }
        );

        // If no PCA data exists and we're asking for the latest (math_tick -1 or undefined),
        // return an empty structure instead of undefined to prevent report failures.
        // `synthesizeEmptyWhenMissing: false` opts out and keeps this path at
        // one query — see getLatestExistingPca.
        if (
          synthesizeEmptyWhenMissing &&
          (math_tick === -1 || math_tick === undefined)
        ) {
          logger.info(
            "No PCA data found, returning empty structure for zid:",
            zid
          );
          return ensureCompletePcaStructure(zid).then((completeData) => {
            const dataWithZid = { ...completeData, zid: zid };
            // No committed row backs this presentation.
            return updatePcaCache(mathEnv, zid, dataWithZid, true);
          });
        }

        return undefined;
      }
      const item = rowsArray[0].data;

      // `!= null`, not truthiness. A committed generation of 0 is a real
      // production state: `math_ticks.math_tick` is `NOT NULL DEFAULT 0`
      // (migrations/000000_initial.sql:649) and every writer mints ticks with
      // `insert into math_ticks (zid, math_env) values (?, ?) on conflict do
      // update set math_tick = math_ticks.math_tick + 1 returning math_tick`,
      // whose INSERT arm returns 0 for the first publication of a
      // (zid, math_env). Under truthiness the column was skipped at 0 and the
      // blob's own engine-local `math_tick` leaked into the served POJO and
      // its ETag.
      if (rowsArray[0].math_tick != null) {
        item.math_tick = Number(rowsArray[0].math_tick);
      }

      // `math_tick` undefined means "give me the latest", the same thing the
      // cached branch above treats as latest, so the floor is -1. Coercing it
      // to 0 with `|| 0` made a committed generation of 0 look "not newer" and
      // reported the conversation as having no math at all. -1 remains the
      // `math_main.math_tick` default for a row that never got a real tick,
      // and such a row stays unserved.
      const requestedMathTick = typeof math_tick === "number" ? math_tick : -1;
      if (item.math_tick <= requestedMathTick) {
        logger.silly("after cache miss, unable to find newer item", {
          zid,
          math_tick,
        });
        return undefined;
      }
      logger.silly("after cache miss, found item, adding to cache", {
        zid,
        math_tick,
      });

      processMathObject(item);

      // Ensure all required fields exist by merging with empty structure if needed
      return ensureCompletePcaStructure(zid, item).then((completeData) => {
        const dataWithZid = { ...completeData, zid: zid };
        return updatePcaCache(mathEnv, zid, dataWithZid);
      });
    });
}

function updatePcaCache(
  mathEnv: string,
  zid: number,
  item: { zid: number },
  synthesized = false
): Promise<PcaCacheItem> {
  return new Promise(function (
    resolve: (arg0: PcaCacheItem) => void,
    reject: (arg0: any) => any
  ) {
    delete item.zid; // don't leak zid
    const asJSON = JSON.stringify(item);
    const buf = Buffer.from(asJSON, "utf-8");
    zlib.gzip(
      buf as unknown as InputType,
      function (err: any, jsondGzipdPcaBuffer: any) {
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
        if (synthesized) {
          synthesizedEntries.add(o);
        }
        // save in LRU cache, but don't update the lastPrefetchedMathTick
        pcaCache.set(pcaCacheKey(mathEnv, zid), o);
        resolve(o);
      }
    );
  });
}

function processMathObject(o: { [x: string]: any }) {
  function remapSubgroupStuff(o: any) {
    if (!o) {
      return o;
    }

    // Helper function to safely map arrays or convert objects to arrays
    function safeMap(
      input: any,
      mapFn: (item: any, index: number) => any
    ): any[] {
      if (Array.isArray(input)) {
        return input.map(mapFn);
      } else if (input && typeof input === "object") {
        return Object.keys(input).map((key) => mapFn(input[key], Number(key)));
      }
      return [];
    }

    // Process all subgroup properties in a single loop
    const subgroupProperties = [
      "group-clusters",
      "repness",
      "group-votes",
      "subgroup-repness",
      "subgroup-votes",
      "subgroup-clusters",
    ];

    subgroupProperties.forEach((prop) => {
      if (o[prop]) {
        o[prop] = safeMap(o[prop], (val, i) => ({
          id: Number(i),
          val: val,
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
    "repness",
    "group-votes",
    "subgroup-repness",
    "subgroup-votes",
    "subgroup-clusters",
  ];

  propsToConvert.forEach((prop) => {
    if (!_.isArray(o[prop])) {
      o[prop] = _.keys(o[prop]).map((gid: string) => ({
        id: Number(gid),
        val: o[prop][gid],
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
