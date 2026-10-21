// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import zlib, { InputType } from "zlib";
import _ from "underscore";
import LruCache from "lru-cache";
import pg from "../db/pg-query";
import { onParticipationPath } from "../db/participation-scope";
import Config from "../config";
import logger from "./logger";
import { addInRamMetric } from "./metered";
import { CachedMathBundleRead, getMathBundle, invalidateMathBundleForTick } from "./mathBundle";

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
 * serialized at any level.
 *
 * It also holds its entries weakly, so membership here never keeps a cache
 * entry alive on its own. That is a retention property, NOT a lifecycle one:
 * eviction from the LRU makes an entry collectable, but nothing guarantees the
 * WeakSet is cleared at that moment. Correctness does not depend on when it is
 * — membership is keyed by object identity, and an evicted entry is
 * unreachable from the cache, so it can never be consulted again.
 */
const synthesizedEntries = new WeakSet<PcaCacheItem>();

/**
 * True when `item` is the empty presentation `getPca` synthesized for a
 * conversation with no committed `math_main` row, rather than a published
 * generation. Its `math_tick: 0` is a placeholder, not a generation, so it must
 * not be given the validator of a real generation 0 (routes/math.ts).
 */
export function isSynthesizedPca(item: PcaCacheItem | undefined): boolean {
  return !!item && synthesizedEntries.has(item);
}

/**
 * The committed `math_main.math_tick` each row-backed entry was built from.
 * Held outside the entry for the same reason as `synthesizedEntries`: the
 * whole entry is serialized by participationInit.
 */
const entryRowTicks = new WeakMap<PcaCacheItem, number>();

/**
 * The latest entry `getPca` built from a `math_main` row, per [math_env, zid].
 *
 * An entry is still served without asking the store for only 3 s, but asking
 * now costs one `math_tick` read on the (zid, math_env) unique index instead
 * of the whole row: when the committed tick is the one this entry was built
 * from, the entry is re-stamped rather than re-read, re-normalized and
 * re-gzipped (`readCommittedTick`). A new generation still shows within 3 s.
 *
 * Kept apart from `pcaCache` because Bundle readers store their own entries in
 * that slot, and some of their callers mutate what they get back; only an
 * entry built here, from a row, is safe to keep serving across windows. The
 * values are the same objects `pcaCache` holds, bounded the same way.
 */
const rowEntries = new LruCache<string, PcaCacheItem>({ max: pcaCacheSize });

type LatestRow =
  | { present: false }
  // `entry` is set exactly when the row holds a committed generation
  // (math_tick > -1); otherwise `data` is the raw blob, uncached.
  | { present: true; mathTick: number; entry?: PcaCacheItem; data?: any };

// The committed tick (`null`: no row), and the re-stamped row entry when the
// tick is the one it was built from.
type CommittedTick = { mathTick: number | null; entry?: PcaCacheItem };

// A row whose generation is not committed yet: `math_main.math_tick` is
// `NOT NULL DEFAULT -1` until a writer stores one (migrations/000000_initial.sql).
const isUncommittedTick = (mathTick: number) => mathTick <= -1;

// One in-flight row read and one in-flight tick read per [math_env, zid], so
// concurrent misses share a single statement.
const pendingRowReads = new Map<string, Promise<LatestRow>>();
const pendingTickReads = new Map<string, Promise<CommittedTick>>();

// An in-flight read is shared only by work on the same pools
// (db/pg-query.ts): a participation request never waits on a read issued on
// the other pools, which slow work may be holding, and the other way round.
// Only the in-flight reads are kept apart; what they cache is shared.
function pendingKey(key: string): string {
  return onParticipationPath() ? `participation:${key}` : key;
}

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
      // Invalidation by tick. This loop is the only place that learns about a
      // new generation without reading the companions, so it is the only place
      // that can retire a cached whole Bundle before its TTL. A Bundle already
      // at this generation is kept; anything else is dropped.
      invalidateMathBundleForTick(
        mathEnv,
        row.zid,
        row.math_tick == null ? null : Number(row.math_tick)
      );
      lastPrefetchedMathTick = Math.max(
        lastPrefetchedMathTick,
        Number(row.caching_tick)
      );
      return presentMathMainRow(mathEnv, row.zid, item);
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
 * Creates a minimal valid PCA structure for conversations with no math results.
 *
 * This is a *template of absences*, not a source of conversation content. It used
 * to query `comments` and backfill `tids` / `n-cmts` / `pca.comment-extremity`, so
 * a conversation with zero votes served a math blob that claimed to contain every
 * approved comment, with a fabricated `center: [0, 0]` and one fabricated `0`
 * extremity per comment. That made the math blob look like a comment index and
 * hid a real bug: a blob whose `tids` covered only *some* approved comments could
 * not be distinguished from one that covered all of them.
 *
 * The math blob's `tids` now means exactly one thing: "the comments that are in
 * the math". Anything that needs the conversation's comments reads the `comments`
 * table (see `getCommentsCount` / `getComments` in src/comment.ts, which apply the
 * conversation's moderation and visibility rules).
 *
 * Kept deliberately unchanged: `comment-projection: {}` (the historical served
 * value on the no-math path; the corrected engine emits `[[], []]` in its own
 * blob, which wins the merge below), `lastVoteTimestamp: Date.now()` and
 * `math_tick: 0` (the no-row fallback's liveness/poll contract, out of scope here).
 *
 * This is the *engine-facing* shape. It is NOT what the API serves: served
 * responses go through `presentPca` (src/utils/pcaPresentation.ts), which puts the
 * historical comment/PCA defaults back on the wire from the `comments` table so
 * already-loaded clients see byte-identical bytes. See `wasMergedWithTemplate`.
 */
function createEmptyPcaStructure(): PcaCacheItem["asPOJO"] {
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
    "n-cmts": 0,
    pca: {
      comps: [[], []],
      center: [],
      "comment-extremity": [],
      "comment-projection": {},
    },
    tids: [],
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
 * Structures that went through the merge below, i.e. that came from a `math_main`
 * row (or from the no-row fallback) on a `getPca` cache miss.
 *
 * `edge` filled the served comment/PCA defaults inside this same merge, so the
 * presentation layer (src/utils/pcaPresentation.ts) may only fill what the merge
 * would have filled. Prefetched rows use this same merge before caching.
 *
 * A WeakSet rather than a property on the object: `handle_GET_participationInit`
 * serializes the whole cache item, so any own enumerable property added here would
 * land on the wire.
 */
const mergedStructures = new WeakSet<object>();

export function wasMergedWithTemplate(
  pojo: object | undefined | null
): boolean {
  return !!pojo && mergedStructures.has(pojo);
}

/**
 * Ensures all required PCA fields exist by merging incomplete data with empty structure
 * This prevents client failures when PCA data exists but is missing required fields
 */
async function ensureCompletePcaStructure(
  existingData?: any
): Promise<PcaCacheItem["asPOJO"]> {
  const emptyStructure = createEmptyPcaStructure();

  if (!existingData) {
    mergedStructures.add(emptyStructure);
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

  mergedStructures.add(mergedData);
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
  if (cached && cached.expiration <= Date.now()) {
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

  return readLatestRow(mathEnv, zid)
    .then((row) => {
      if (!row.present) {
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
          return ensureCompletePcaStructure().then((completeData) => {
            // Assigned in place rather than spread into a copy: the structure is
            // freshly built by the merge, and the copy would drop the merge mark
            // `presentPca` reads. Key order is identical either way (an existing
            // `zid` keeps its position; a new one is appended and then deleted by
            // `updatePcaCache`).
            const dataWithZid = Object.assign(completeData, { zid: zid });
            // No committed row backs this presentation.
            return updatePcaCache(mathEnv, zid, dataWithZid, true);
          });
        }

        return undefined;
      }

      // `math_tick` undefined means "give me the latest", the same thing the
      // cached branch above treats as latest, so the floor is -1. Coercing it
      // to 0 with `|| 0` made a committed generation of 0 look "not newer" and
      // reported the conversation as having no math at all. -1 remains the
      // `math_main.math_tick` default for a row that never got a real tick,
      // and such a row stays unserved.
      const requestedMathTick = typeof math_tick === "number" ? math_tick : -1;
      if (row.mathTick <= requestedMathTick) {
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

      if (row.entry) {
        return row.entry;
      }
      // Only an explicit math_tick below -1 asks for an uninitialized row.
      // The shared read handed every waiter the same blob, and presenting it
      // mutates it, so present a copy.
      return presentMathMainRow(mathEnv, zid, structuredClone(row.data));
    });
}

/**
 * The latest `math_main` row for [math_env, zid], shared by concurrent misses.
 *
 * When a row-backed entry is remembered, the committed tick is read first and
 * an unchanged generation is served again without the blob. Otherwise the
 * whole row is read, and a committed generation is presented and cached.
 */
function readLatestRow(mathEnv: string, zid: number): Promise<LatestRow> {
  const key = pcaCacheKey(mathEnv, zid);
  const inFlight = pendingKey(key);
  const pending = pendingRowReads.get(inFlight);
  if (pending) {
    return pending;
  }
  const revalidated: Promise<CommittedTick> = rowEntries.has(key)
    ? readCommittedTick(mathEnv, zid)
    : Promise.resolve({ mathTick: null });
  const read = revalidated
    .then(({ entry }): LatestRow | Promise<LatestRow> =>
      entry
        ? { present: true, mathTick: entry.asPOJO.math_tick, entry }
        : selectLatestRow(mathEnv, zid)
    )
    .finally(() => {
      pendingRowReads.delete(inFlight);
    });
  pendingRowReads.set(inFlight, read);
  return read;
}

function selectLatestRow(mathEnv: string, zid: number): Promise<LatestRow> {
  const queryStart = Date.now();

  return pg
    .queryP_readOnly<Array<{ data: any; math_tick: any }>>(
      "select * from math_main where zid = ($1) and math_env = ($2);",
      [zid, mathEnv]
    )
    .then((rows): LatestRow | Promise<LatestRow> => {
      const queryEnd = Date.now();
      const queryDuration = queryEnd - queryStart;
      addInRamMetric("pcaGetQuery", queryDuration);

      // Ensure rows is an array with proper type assertion
      const rowsArray = rows as Array<{ data: any; math_tick: any }>;

      if (!rowsArray || !rowsArray.length) {
        return { present: false };
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
      const mathTick = item.math_tick;
      if (isUncommittedTick(mathTick)) {
        return { present: true, mathTick, data: item };
      }
      // A blob without a usable lastVoteTimestamp is given the template's
      // Date.now() (ensureCompletePcaStructure), so its served bytes change
      // on every read. It is not remembered, and is read again each window.
      const takesClock =
        typeof item.lastVoteTimestamp !== "number" && !item.lastVoteTimestamp;
      return presentMathMainRow(mathEnv, zid, item).then((entry) => {
        if (!takesClock) {
          entryRowTicks.set(entry, mathTick);
          rowEntries.set(pcaCacheKey(mathEnv, zid), entry);
        }
        return { present: true, mathTick, entry };
      });
    });
}

/**
 * The committed generation of [math_env, zid], read without the blob: the
 * `math_tick` column only, on the unique (zid, math_env) index, so the
 * TOASTed `data` is never fetched. `null` when there is no row.
 *
 * When it is the generation the remembered row entry was built from, that
 * entry is re-stamped with a fresh 3 s expiration and returned. Any other
 * answer forgets the remembered entry, so the next miss reads the row.
 */
function readCommittedTick(
  mathEnv: string,
  zid: number
): Promise<CommittedTick> {
  const key = pcaCacheKey(mathEnv, zid);
  const inFlight = pendingKey(key);
  const pending = pendingTickReads.get(inFlight);
  if (pending) {
    return pending;
  }
  const remembered = rowEntries.get(key);
  const read = pg
    .queryP_readOnly<Array<{ math_tick: any }>>(
      "select math_tick from math_main where zid = ($1) and math_env = ($2);",
      [zid, mathEnv]
    )
    .then((rows) => {
      const rowsArray = rows as Array<{ math_tick: any }>;
      const mathTick =
        rowsArray && rowsArray.length ? Number(rowsArray[0].math_tick) : null;
      // Another reader replaced the remembered entry while this ran.
      if (!remembered || rowEntries.get(key) !== remembered) {
        return { mathTick };
      }
      if (mathTick !== entryRowTicks.get(remembered)) {
        rowEntries.del(key);
        return { mathTick };
      }
      const entry = restampedEntry(remembered);
      entryRowTicks.set(entry, mathTick);
      rowEntries.set(key, entry);
      // Stored as updatePcaCache stores a fresh read.
      pcaCache.set(key, entry);
      return { mathTick, entry };
    })
    .finally(() => {
      pendingTickReads.delete(inFlight);
    });
  pendingTickReads.set(inFlight, read);
  return read;
}

/**
 * The generation `getPca(zid, -1)` would serve now, learned without reading
 * the blob: from a live cache entry, or else from the committed tick.
 * `undefined` when that answer carries no generation tag -- no row, an
 * uninitialized row, or the synthesized empty presentation.
 *
 * GET /math/pca2 compares a held entity tag with this before any blob I/O.
 */
export function getLatestPcaTick(zid: number): Promise<number | undefined> {
  const mathEnv = Config.mathEnv;
  const cached = pcaCache.get(pcaCacheKey(mathEnv, zid));
  if (cached && cached.expiration > Date.now() && cached.asPOJO) {
    return Promise.resolve(
      synthesizedEntries.has(cached) ? undefined : cached.asPOJO.math_tick
    );
  }
  return readCommittedTick(mathEnv, zid).then(({ mathTick }) =>
    mathTick === null || isUncommittedTick(mathTick) ? undefined : mathTick
  );
}

/** A generation's `comment-priorities`: tid -> selection weight. */
export type CommentPriorities = Record<string | number, number>;

/** The math generation a priorities map was read from. */
export type CommentPrioritiesGeneration = { mathTick: number; mathEnv: string };

// Every map getLatestCommentPriorities hands out, keyed by the object itself,
// so a caller can name the generation of the exact map it used (the serve log
// in nextComment.ts) without a second read that a newer generation could race.
const prioritiesGenerations = new WeakMap<
  object,
  CommentPrioritiesGeneration
>();

function withGeneration<T extends CommentPriorities | undefined>(
  priorities: T,
  mathTick: unknown,
  mathEnv: string
): T {
  if (
    priorities &&
    typeof priorities === "object" &&
    typeof mathTick === "number" &&
    !isUncommittedTick(mathTick)
  ) {
    prioritiesGenerations.set(priorities, { mathTick, mathEnv });
  }
  return priorities;
}

/**
 * The committed `math_tick` and `math_env` of a map returned by
 * `getLatestCommentPriorities`; `undefined` for anything else (no map, or a
 * map that did not come from a committed generation).
 */
export function commentPrioritiesGeneration(
  priorities: CommentPriorities | undefined
): CommentPrioritiesGeneration | undefined {
  return priorities && typeof priorities === "object"
    ? prioritiesGenerations.get(priorities)
    : undefined;
}

type PrioritiesEntry = {
  mathTick: number;
  priorities: CommentPriorities;
  expiration: number;
};

/**
 * The `comment-priorities` of the latest committed generation, per
 * [math_env, zid], for next-statement selection. Bounded like the math cache.
 *
 * An entry is used for 3 s, like a math cache entry. After that the committed
 * tick is read (`readCommittedTick`, shared with the math cache) and an
 * unchanged generation is re-stamped. Only a new generation reads the map,
 * and then only that field of the row (`selectLatestPriorities`).
 */
const prioritiesEntries = new LruCache<string, PrioritiesEntry>({
  max: pcaCacheSize,
});
// One in-flight priorities read per [math_env, zid].
const pendingPriorityReads = new Map<
  string,
  Promise<PrioritiesEntry | undefined>
>();

const PRIORITIES_WINDOW_MS = 3000;

/**
 * The `comment-priorities` that `getLatestExistingPca(zid)` would hand the
 * next-statement draw, without reading the whole math result.
 *
 * - A live math cache entry is what `getLatestExistingPca` would serve, so its
 *   map is used, and remembered under its generation.
 * - Otherwise a live priorities entry is used.
 * - Otherwise the committed tick decides: the same generation is re-stamped;
 *   a new one reads `data->'comment-priorities'` only. Concurrent callers
 *   share one read.
 *
 * `undefined` when there is no committed generation (no row, or a row whose
 * tick is not committed yet), where `getLatestExistingPca` gives no math. A
 * failed read rejects, as the whole-row read did.
 *
 * The returned map's generation is available from
 * `commentPrioritiesGeneration(map)`.
 */
export function getLatestCommentPriorities(
  zid: number
): Promise<CommentPriorities | undefined> {
  const mathEnv = Config.mathEnv;
  const key = pcaCacheKey(mathEnv, zid);
  const now = Date.now();
  const cached = pcaCache.get(key);
  if (
    cached &&
    cached.expiration > now &&
    cached.asPOJO &&
    !synthesizedEntries.has(cached)
  ) {
    const priorities = cached.asPOJO["comment-priorities"];
    const mathTick = cached.asPOJO.math_tick;
    const current = prioritiesEntries.get(key);
    if (
      typeof mathTick === "number" &&
      !isUncommittedTick(mathTick) &&
      (!current || current.expiration < cached.expiration)
    ) {
      prioritiesEntries.set(key, {
        mathTick,
        priorities: completePriorities(priorities),
        expiration: cached.expiration,
      });
    }
    return Promise.resolve(withGeneration(priorities, mathTick, mathEnv));
  }
  const entry = prioritiesEntries.get(key);
  if (entry && entry.expiration > now) {
    return Promise.resolve(
      withGeneration(entry.priorities, entry.mathTick, mathEnv)
    );
  }
  return readLatestPriorities(mathEnv, zid).then((read) =>
    read ? withGeneration(read.priorities, read.mathTick, mathEnv) : undefined
  );
}

function readLatestPriorities(
  mathEnv: string,
  zid: number
): Promise<PrioritiesEntry | undefined> {
  const key = pcaCacheKey(mathEnv, zid);
  const inFlight = pendingKey(key);
  const pending = pendingPriorityReads.get(inFlight);
  if (pending) {
    return pending;
  }
  const revalidated: Promise<CommittedTick> = prioritiesEntries.has(key)
    ? readCommittedTick(mathEnv, zid)
    : Promise.resolve({ mathTick: null });
  const read = revalidated
    .then(({ mathTick }) => {
      const remembered = prioritiesEntries.get(key);
      if (remembered && mathTick !== null && remembered.mathTick === mathTick) {
        const entry = {
          ...remembered,
          expiration: Date.now() + PRIORITIES_WINDOW_MS,
        };
        prioritiesEntries.set(key, entry);
        return entry;
      }
      return selectLatestPriorities(mathEnv, zid);
    })
    .finally(() => {
      pendingPriorityReads.delete(inFlight);
    });
  pendingPriorityReads.set(inFlight, read);
  return read;
}

/**
 * The committed tick and `comment-priorities` of [math_env, zid]. Only that
 * field of `data` leaves the database: no blob crosses the wire, and nothing
 * is normalized or compressed in this process.
 */
function selectLatestPriorities(
  mathEnv: string,
  zid: number
): Promise<PrioritiesEntry | undefined> {
  const key = pcaCacheKey(mathEnv, zid);
  return pg
    .queryP_readOnly<Array<{ math_tick: any; priorities: any }>>(
      "select math_tick, data->'comment-priorities' as priorities from math_main where zid = ($1) and math_env = ($2);",
      [zid, mathEnv]
    )
    .then((rows) => {
      const rowsArray = rows as Array<{ math_tick: any; priorities: any }>;
      const row = rowsArray && rowsArray.length ? rowsArray[0] : undefined;
      // `math_main.math_tick` is NOT NULL (migrations/000000_initial.sql).
      const mathTick = row ? Number(row.math_tick) : null;
      if (mathTick === null || isUncommittedTick(mathTick)) {
        prioritiesEntries.del(key);
        return undefined;
      }
      const entry = {
        mathTick,
        priorities: completePriorities(row.priorities),
        expiration: Date.now() + PRIORITIES_WINDOW_MS,
      };
      prioritiesEntries.set(key, entry);
      return entry;
    });
}

// The normalization `ensureCompletePcaStructure` gives the field.
function completePriorities(value: unknown): CommentPriorities {
  return value && typeof value === "object" ? (value as CommentPriorities) : {};
}

/**
 * Normalize one owned `math_main.data` blob and cache its engine-facing shape.
 *
 * Shared by `getPca`'s row path and the Bundle reader so both produce the
 * same marked structure for the response-boundary `presentPca` call. `item` is
 * mutated by `processMathObject`, so callers must hand over a blob they own.
 *
 * `ensureCompletePcaStructure` only merges the template of absences. The
 * comment-owned `tids` / `n-cmts` and legacy PCA defaults are composed by
 * `presentPca` in pcaPresentation.ts, never stored in the raw Bundle.
 */
function presentMathMainRow(
  mathEnv: string,
  zid: number,
  item: PcaCacheItem["asPOJO"],
  sourceExpiration?: number
): Promise<PcaCacheItem> {
  processMathObject(item);

  // Ensure all required fields exist by merging with empty structure if needed
  return ensureCompletePcaStructure(item).then((completeData) => {
    // Preserve the WeakSet merge mark that presentPca checks. Spreading into
    // a new object would silently skip C7's comment-owned presentation.
    const dataWithZid = Object.assign(completeData, { zid: zid });
    return updatePcaCache(mathEnv, zid, dataWithZid, false, sourceExpiration);
  });
}

/**
 * The latest presentation, read through a coherent Bundle.
 *
 * `getPca(zid)` reads `math_main` on its own, so a report that also joins
 * participants to groups could mix generations across its several reads. This
 * consults the shared presentation cache first, then loads a Bundle on a
 * miss. Only that miss observes companion admission; this main-only helper
 * does not establish request-wide coherence for other independent reads.
 *
 * It is deliberately byte-identical to `getPca(zid)`:
 *
 *  - the presentation cache is consulted first, with `getPca`'s own freshness
 *    rule, so a prefetched entry is still what a report sees;
 *  - a conversation with no `math_main` row falls through to `getPca`, which
 *    synthesizes the empty presentation and shares one cache entry for it --
 *    that entry stamps `lastVoteTimestamp: Date.now()`, so bypassing it would
 *    change bytes between two reads in the same report;
 *  - an uninitialized row (`math_tick` still at -1) gets a synthesized empty
 *    presentation, just like a missing row, so reports can still render.
 *
 * A refused Bundle is logged by `getMathBundle` and then presented from its
 * main row anyway. Every field a report reads is main-owned -- the
 * participant-to-group join runs through `base-clusters.members`, not through
 * `math_bidtopid` -- so refusing here would remove a report that is correct
 * today, while the joining callers (`getPidsForGid`, `getBidsForPids`) do
 * refuse because their answer genuinely spans two tables.
 */
export async function getPcaFromBundle(
  zid: number
): Promise<PcaCacheItem | undefined> {
  const mathEnv = Config.mathEnv;
  let cached = pcaCache.get(pcaCacheKey(mathEnv, zid));
  if (cached && cached.expiration <= Date.now()) {
    cached = undefined;
  }
  if (cached && cached.asPOJO) {
    logger.silly("math from bundle cache (latest requested)", { zid });
    return cached;
  }

  const read = await getMathBundle(zid, mathEnv);
  if (!read.present) {
    return getPca(zid);
  }

  if (read.mathTick <= -1) {
    // An uninitialized row has no publishable math. Reports still need an
    // empty presentation; retain synthesized provenance for routing readers.
    return ensureCompletePcaStructure().then((data) =>
      updatePcaCache(mathEnv, zid, Object.assign(data, { zid }), true, read.expiration)
    );
  }
  return presentExistingMathBundle(zid, mathEnv, read);
}

/** Present the request's own main, without consulting the independent PCA cache. */
export function presentExistingMathBundle(
  zid: number,
  mathEnv: string,
  read: CachedMathBundleRead
): Promise<PcaCacheItem | undefined> {
  if (!read.present || read.mathTick <= -1) return Promise.resolve(undefined);
  // The cached Bundle is shared by every concurrent reader and
  // `processMathObject` mutates in place, so present a copy.
  const item = structuredClone(read.main) as PcaCacheItem["asPOJO"];
  item.math_tick = read.mathTick;
  return presentMathMainRow(mathEnv, zid, item, read.expiration);
}

function updatePcaCache(
  mathEnv: string,
  zid: number,
  item: { zid: number },
  synthesized = false,
  sourceExpiration = Infinity
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
          expiration: Math.min(Date.now() + 3000, sourceExpiration),
          consensus: (item as any).consensus || { agree: [], disagree: [] },
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

/**
 * A row-backed entry stamped as if `updatePcaCache` had just stored it from a
 * fresh read of the same generation: the same body, JSON and gzip, a new
 * 3 s expiration. A new object, so `presentPca` re-derives its comment
 * defaults on the same schedule as before. Keys keep `updatePcaCache`'s order
 * because participationInit serializes the entry.
 */
function restampedEntry(entry: PcaCacheItem): PcaCacheItem {
  return {
    asPOJO: entry.asPOJO,
    asJSON: entry.asJSON,
    asBufferOfGzippedJson: entry.asBufferOfGzippedJson,
    expiration: Date.now() + 3000,
    consensus: entry.consensus,
    repness: entry.repness,
  };
}

export function processMathObject(o: { [x: string]: any }) {
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

  // A malformed group-clusters entry (null, or not an object with a numeric
  // id) is refused, not dereferenced: the whole field is presented as having
  // no groups and the refusal is logged (P-070 review [1447] B). The writer's
  // validity rule never publishes such a bundle; this guards older rows.
  const isPlainObject = (v: any) =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (
    _.isArray(o["group-clusters"]) &&
    !o["group-clusters"].every(
      (g: any) => isPlainObject(g) && typeof g.id === "number"
    )
  ) {
    logger.error("polis_err_math_malformed_group_clusters", {
      zid: o.zid,
      count: o["group-clusters"].length,
    });
    o["group-clusters"] = [];
  }

  // repness and group-votes are keyed objects ({gid: entry}) and `toObj`
  // below dereferences every entry. P-070 review [1449] B: an array such as
  // `[null]` reached `a[i].val` and threw, and `[1]` / `[{}]` were silently
  // presented as empty. Each entry is now checked against the producer's
  // shape before anything dereferences it; a field with any malformed entry
  // (or a non-empty array in place of the keyed object) is refused as a
  // whole, logged, and presented empty -- never thrown on, never emptied
  // silently. Absent, null and `[]` stay the empty form they were.
  const entryContracts: Record<string, (v: any) => boolean> = {
    repness: (v) => Array.isArray(v) && v.every(isPlainObject),
    "group-votes": (v) => isPlainObject(v) && isPlainObject(v.votes),
  };
  Object.keys(entryContracts).forEach((field) => {
    const value = o[field];
    if (value === undefined || value === null) {
      return;
    }
    const valid = isPlainObject(value)
      ? Object.keys(value).every((k) => entryContracts[field](value[k]))
      : Array.isArray(value) && value.length === 0;
    if (!valid) {
      logger.error("polis_err_math_malformed_" + field.replace("-", "_"), {
        zid: o.zid,
        count: Array.isArray(value) ? value.length : _.keys(value).length,
      });
      o[field] = {};
    }
  });

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
      const entry = a[i];
      const val = entry && entry.val;
      if (val === null || typeof val !== "object") {
        // Unreachable for repness/group-votes, whose entries are checked
        // above; kept so no entry is ever dereferenced unchecked.
        continue;
      }
      obj[a[i].id] = val;
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
