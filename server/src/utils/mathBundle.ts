// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

/**
 * The coherent math Bundle reader.
 *
 * ## What was wrong
 *
 * Every math consumer in this server used to read the math tables one at a
 * time, each on its own connection and therefore its own snapshot:
 *
 *   - `getPca` selects `math_main`                (utils/pca.ts)
 *   - `getBidIndexToPidMapping` selects `math_bidtopid`  (utils/participants.ts)
 *
 * and `getPidsForGid` / `getBidsForPids` join the two by issuing both, in
 * parallel, with nothing pinning them to one generation. A publication that
 * commits between the two statements is therefore served as an OLD main with a
 * NEW mapping: `base-clusters.id` from generation N indexed with `bidToPid`
 * from generation N+1. Base-cluster ids are reused across generations, so the
 * result is not an error — it is a plausible, wrong, list of participants.
 *
 * ## What this module does
 *
 * `loadBundle` reads `math_main`, `math_bidtopid`, `math_ptptstats` and the
 * `math_ticks` checkpoint for one `(zid, math_env)` in a SINGLE statement.
 * PostgreSQL evaluates one statement against one snapshot, so every row in the
 * result belongs to the same visible generation whatever else commits during
 * the read. That is the "joined read" half of the contract's
 * "joined read or read-only repeatable-read `loadBundle`"; it is preferred
 * here over `REPEATABLE READ` because the server reads through a pool
 * (`db/pg-query.ts`) and a single statement needs no pinned connection, no
 * BEGIN/COMMIT round trips and no long-lived snapshot.
 *
 * Admission then requires all three companions to exist at the SAME column
 * `math_tick` as main. A missing companion or a tick mismatch is refused
 * rather than served torn — the same admission the candidate reader applies.
 *
 * The accessors (`pidsForGid`, `bidsForPids`, `bidToPidIndex`) are pure: they
 * derive their answer from the Bundle's own rows and never issue a query, so a
 * mapping can never come from a different generation than the main it is
 * joined against.
 *
 * ## Comment-owned data is deliberately NOT in the Bundle
 *
 * A Bundle holds math-owned rows only. The approved-comment listing that the
 * served presentation carries (`tids`, `n-cmts`) is comment-owned: it changes
 * when a moderator approves a comment, at an unchanged math tick. Putting it
 * in a tick-keyed cache would serve a stale listing indefinitely, which the
 * contract forbids ("never cache comment listings solely by math tick"). It is
 * therefore composed at presentation time by `ensureCompletePcaStructure`
 * (utils/pca.ts) and only ever held in the short-TTL presentation cache.
 */

import LruCache from "lru-cache";

import pg from "../db/pg-query";
import Config from "../config";
import logger from "./logger";

/** The three rows that must accompany `math_main` at the same generation. */
export type MathBundleCompanion =
  | "math_bidtopid"
  | "math_ptptstats"
  | "math_ticks";

/** The `math_main.data` JSONB, as stored — before any presentation transform. */
export type MathMainData = {
  "group-clusters"?: Array<{
    id?: number;
    members?: number[];
    center?: number[];
  }>;
  "base-clusters"?: {
    id?: number[];
    members?: number[][];
    [key: string]: unknown;
  };
  math_tick?: number;
  [key: string]: unknown;
};

/** The `math_bidtopid.data` JSONB: base-cluster INDEX -> the pids in it. */
export type MathBidToPidData = {
  bidToPid?: number[][];
  math_tick?: number;
  [key: string]: unknown;
};

/** The `math_ptptstats.data` JSONB. Read for admission; no server route uses it. */
export type MathPtptStatsData = {
  math_tick?: number;
  [key: string]: unknown;
};

/**
 * One immutable generation of a conversation's math, in one namespace.
 *
 * Every field was read by one statement against one snapshot, and every
 * companion was checked to carry `mathTick`. Nothing here may be mutated:
 * cached Bundles are shared by every concurrent request for the conversation.
 */
export type MathBundle = {
  readonly mathEnv: string;
  readonly zid: number;
  /** The `math_tick` COLUMN, shared by all four rows. Not the blob's own field. */
  readonly mathTick: number;
  readonly cachingTick: number;
  readonly lastVoteTimestamp: number;
  readonly main: MathMainData;
  readonly bidToPid: MathBidToPidData;
  readonly ptptStats: MathPtptStatsData;
};

export type MathBundleRefusal =
  | {
      readonly reason: "missing_companion";
      readonly companion: MathBundleCompanion;
    }
  | {
      readonly reason: "tick_mismatch";
      readonly companion: MathBundleCompanion;
      readonly companionTick: number;
      readonly mainTick: number;
    };

/**
 * The outcome of a Bundle read.
 *
 * `present: false` — no `math_main` row for this `(zid, math_env)` at all.
 *   Not a refusal: a conversation whose math has never run is a normal state
 *   and callers keep their existing no-math behaviour.
 *
 * `present: true, admitted: false` — main exists but the generation is
 *   incoherent. `main` and `mathTick` are still reported, because a caller
 *   that only needs main-owned fields may legitimately continue; a caller that
 *   joins across tables must not.
 */
export type MathBundleRead =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly admitted: true;
      readonly bundle: MathBundle;
      readonly main: MathMainData;
      readonly mathTick: number;
    }
  | {
      readonly present: true;
      readonly admitted: false;
      readonly refusal: MathBundleRefusal;
      readonly main: MathMainData;
      readonly mathTick: number;
    };

type BundleRow = {
  main_data: MathMainData;
  main_math_tick: string | number | null;
  main_caching_tick: string | number | null;
  last_vote_timestamp: string | number | null;
  bidtopid_data: MathBidToPidData | null;
  bidtopid_math_tick: string | number | null;
  ptptstats_data: MathPtptStatsData | null;
  ptptstats_math_tick: string | number | null;
  ticks_math_tick: string | number | null;
};

/**
 * One snapshot, one statement. `math_main`, `math_bidtopid`, `math_ptptstats`
 * and `math_ticks` are each `UNIQUE (zid, math_env)`
 * (postgres/migrations/000000_initial.sql:647-706), so the LEFT JOINs cannot
 * multiply rows and a NULL companion column means the row is genuinely absent.
 * `math_env` is on every join predicate, so a Bundle can never mix namespaces.
 */
const BUNDLE_QUERY =
  "select" +
  "  m.data as main_data," +
  "  m.math_tick as main_math_tick," +
  "  m.caching_tick as main_caching_tick," +
  "  m.last_vote_timestamp as last_vote_timestamp," +
  "  b.data as bidtopid_data," +
  "  b.math_tick as bidtopid_math_tick," +
  "  p.data as ptptstats_data," +
  "  p.math_tick as ptptstats_math_tick," +
  "  t.math_tick as ticks_math_tick" +
  " from math_main m" +
  " left join math_bidtopid b on b.zid = m.zid and b.math_env = m.math_env" +
  " left join math_ptptstats p on p.zid = m.zid and p.math_env = m.math_env" +
  " left join math_ticks t on t.zid = m.zid and t.math_env = m.math_env" +
  " where m.zid = ($1) and m.math_env = ($2);";

// node-postgres hands BIGINT back as a string (no int8 type parser is
// registered anywhere in db/pg-query.ts), so every tick is coerced here once.
function toTick(value: string | number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

/**
 * Read one coherent Bundle for `(zid, mathEnv)`. Always hits the database;
 * `getMathBundle` is the cache-aware entry point.
 */
export async function loadBundle(
  zid: number,
  mathEnv: string = Config.mathEnv
): Promise<MathBundleRead> {
  // `queryP_impl` resolves an untyped Promise, so the row shape is asserted
  // here once rather than being re-asserted at every use.
  const rows = (await pg.queryP_readOnly<BundleRow[]>(BUNDLE_QUERY, [
    zid,
    mathEnv,
  ])) as BundleRow[];
  if (!rows || !rows.length) {
    return { present: false };
  }
  const row = rows[0];
  const mainTick = toTick(row.main_math_tick) ?? -1;
  const main = row.main_data;

  const companions: Array<{
    companion: MathBundleCompanion;
    data: MathBidToPidData | MathPtptStatsData | null;
    tick: number | null;
  }> = [
    {
      companion: "math_bidtopid",
      data: row.bidtopid_data,
      tick: toTick(row.bidtopid_math_tick),
    },
    {
      companion: "math_ptptstats",
      data: row.ptptstats_data,
      tick: toTick(row.ptptstats_math_tick),
    },
    // math_ticks carries no payload; it is the checkpoint whose generation the
    // three payload rows are supposed to share.
    { companion: "math_ticks", data: {}, tick: toTick(row.ticks_math_tick) },
  ];

  for (const companion of companions) {
    if (companion.tick === null || companion.data === null) {
      return {
        present: true,
        admitted: false,
        refusal: {
          reason: "missing_companion",
          companion: companion.companion,
        },
        main,
        mathTick: mainTick,
      };
    }
    if (companion.tick !== mainTick) {
      return {
        present: true,
        admitted: false,
        refusal: {
          reason: "tick_mismatch",
          companion: companion.companion,
          companionTick: companion.tick,
          mainTick,
        },
        main,
        mathTick: mainTick,
      };
    }
  }

  return {
    present: true,
    admitted: true,
    main,
    mathTick: mainTick,
    bundle: {
      mathEnv,
      zid,
      mathTick: mainTick,
      cachingTick: toTick(row.main_caching_tick) ?? 0,
      lastVoteTimestamp: toTick(row.last_vote_timestamp) ?? 0,
      main,
      bidToPid: row.bidtopid_data as MathBidToPidData,
      ptptStats: row.ptptstats_data as MathPtptStatsData,
    },
  };
}

// ---------------------------------------------------------------------------
// The bounded whole-Bundle cache
// ---------------------------------------------------------------------------

/**
 * Size bound.
 *
 * This replaces the per-piece caching the joining callers used to rely on: the
 * main blob came from `pcaCache` while `math_bidtopid` was re-queried on every
 * single call and never cached at all. One entry now holds the whole
 * generation, so a caller cannot assemble one from two different reads.
 *
 * 100 is deliberate rather than copied from `pcaCache`'s 300. A `pcaCache`
 * entry stores the presented POJO, its JSON string AND its gzip buffer -- call
 * it ~2.2x a main blob. A Bundle stores the raw main blob plus the two
 * companions, which are small next to main -- call it ~1.3x. At 100 entries
 * the Bundle cache is therefore worth roughly 130 main-blob-equivalents
 * against `pcaCache`'s ~660, i.e. it adds about a fifth to this server's math
 * residency while still covering the conversations a single server has in
 * flight. `cacheMathResults=false` collapses both caches to one entry, exactly
 * as `pcaCache` already does.
 */
export const MATH_BUNDLE_CACHE_MAX = Config.cacheMathResults ? 100 : 1;

/**
 * Freshness bound, in ms. The same characterized TTL `updatePcaCache` uses, so
 * a Bundle never outlives the presentation built from it and the observable
 * staleness window of the math tables is unchanged.
 */
export const MATH_BUNDLE_TTL_MS = 3000;

type BundleCacheEntry = {
  read: MathBundleRead;
  /** The generation this entry describes; -1 when there is no main row. */
  mathTick: number;
  expiration: number;
};

const bundleCache = new LruCache<string, BundleCacheEntry>({
  max: MATH_BUNDLE_CACHE_MAX,
});

// Namespaces are independent publications of the same conversation, so the key
// carries math_env -- the same key shape pcaCache uses.
function bundleCacheKey(mathEnv: string, zid: number): string {
  return JSON.stringify([mathEnv, zid]);
}

function readTick(read: MathBundleRead): number {
  return read.present ? read.mathTick : -1;
}

/**
 * Invalidation by tick.
 *
 * The background poller (`prefetchLatestPcaData`) learns about new generations
 * from `math_main.caching_tick` without reading the companions, so it is the
 * one place that can know a cached Bundle is stale before its TTL expires.
 * Drop the entry unless it already describes exactly `mathTick`.
 */
export function invalidateMathBundleForTick(
  mathEnv: string,
  zid: number,
  mathTick: number | null
): void {
  const key = bundleCacheKey(mathEnv, zid);
  const entry = bundleCache.get(key);
  if (!entry) {
    return;
  }
  if (mathTick === null || entry.mathTick !== mathTick) {
    bundleCache.del(key);
  }
}

/** Test-only, and used by nothing on a request path. */
export function clearMathBundleCache(): void {
  bundleCache.reset();
}

/**
 * The cache-aware Bundle read. Captures the namespace before any async work,
 * so a `Config.mathEnv` change in flight cannot relabel the result -- the same
 * rule `getPca` and `prefetchLatestPcaData` follow.
 */
export async function getMathBundle(
  zid: number,
  mathEnv: string = Config.mathEnv
): Promise<MathBundleRead> {
  const key = bundleCacheKey(mathEnv, zid);
  const cached = bundleCache.get(key);
  if (cached && cached.expiration > Date.now()) {
    return cached.read;
  }
  const read = await loadBundle(zid, mathEnv);
  if (read.present === false) {
    logger.silly("math bundle absent", { zid, math_env: mathEnv });
  } else if (read.admitted === false) {
    logger.warn("polis_math_bundle_refused", {
      zid,
      math_env: mathEnv,
      main_tick: read.mathTick,
      ...read.refusal,
    });
  }
  bundleCache.set(key, {
    read,
    mathTick: readTick(read),
    expiration: Date.now() + MATH_BUNDLE_TTL_MS,
  });
  return read;
}

// ---------------------------------------------------------------------------
// Pure accessors -- Bundle in, answer out, never a query
// ---------------------------------------------------------------------------

/** base-cluster id -> its index in `base-clusters` / `bidToPid`. */
function bidToIndex(bundle: MathBundle): number[] {
  const indexToBid = bundle.main["base-clusters"]?.id || [];
  const index: number[] = [];
  for (let i = 0; i < indexToBid.length; i++) {
    index[indexToBid[i]] = i;
  }
  return index;
}

/**
 * The participants of one group, joined through the Bundle's OWN mapping.
 *
 * Identical arithmetic to the pre-Bundle `getPidsForGid`, with the two inputs
 * guaranteed to be one generation instead of two independent reads.
 */
export function pidsForGid(bundle: MathBundle, gid: number): number[] {
  const clusters = bundle.main["group-clusters"] || [];
  const cluster = clusters[gid];
  if (!cluster) {
    return [];
  }
  const indexOfBid = bidToIndex(bundle);
  const indexToPids = bundle.bidToPid.bidToPid;
  const members = cluster.members || [];
  let pids: number[] = [];
  for (let i = 0; i < members.length; i++) {
    const morePids = indexToPids
      ? indexToPids[indexOfBid[members[i]]]
      : undefined;
    if (morePids) {
      Array.prototype.push.apply(pids, morePids);
    }
  }
  pids = pids.map(function (x) {
    return parseInt(String(x));
  });
  pids.sort(function (a, b) {
    return a - b;
  });
  return pids;
}

/**
 * pid -> base-cluster id, joined through the Bundle's OWN mapping.
 *
 * A pid the mapping does not place stays `undefined`, exactly as the previous
 * two-read implementation left it, and `doFamousQuery` reads that as "not
 * bucketized yet".
 */
export function bidsForPids(
  bundle: MathBundle,
  pids: number[]
): Record<number, number | undefined> {
  const b2p = bundle.bidToPid.bidToPid || [];
  const indexToBid = bundle.main["base-clusters"]?.id || [];
  const result: Record<number, number | undefined> = {};
  for (const pid of pids) {
    let bidi = -1;
    for (let i = 0; i < b2p.length; i++) {
      if (b2p[i].indexOf(pid) !== -1) {
        bidi = i;
        break;
      }
    }
    let bid = indexToBid[bidi];
    if (bidi >= 0 && bid === undefined) {
      logger.error("polis_err_math_index_mapping_mismatch", { pid, b2p });
      bid = -1;
    }
    result[pid] = bid;
  }
  return result;
}
