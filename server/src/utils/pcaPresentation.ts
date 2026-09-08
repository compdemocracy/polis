// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import zlib, { InputType } from "zlib";
import LruCache from "lru-cache";
import Config from "../config";
import pg from "../db/pg-query";
import logger from "./logger";
import { PcaCacheItem, templateDefaultsFor } from "./pca";

/**
 * Served presentation of the math blob.
 *
 * The math engine emits an honest EMPTY result for a conversation with no votes:
 * no comment ids, no `n-cmts`, no `center`, no extremities (see
 * `createEmptyPcaStructure` in ./pca.ts, which is now a template of absences and
 * asks the database nothing). That is the engine-facing truth and what the
 * certification golden pins.
 *
 * It is NOT what the API may serve. Until `edge`, the server filled those four
 * fields from the `comments` table inside the cached blob, and 2,884 production
 * conversations plus every already-loaded client depend on the resulting bytes.
 * Changing the engine must not change them, so the fill moves here: to the
 * response boundary, after the cache, applied only to fields the math genuinely
 * did not supply.
 *
 * The result is byte-identical to `edge` for every blob shape, including the
 * no-math-row fallback, because:
 *   - the query is the one `edge` used, verbatim, with the same error fallback;
 *   - the fields are filled only where `edge`'s merge would have used its
 *     template value (`templateDefaultsFor`, recorded during that same merge);
 *   - the POJO is rebuilt by spreading, so key order — and therefore the JSON
 *     and the gzip of it — is unchanged.
 *
 * Freshness matches `edge` exactly rather than approximately. `edge` re-ran the
 * backfill inside `getPca` on every cache miss, i.e. at most once per 3 s per
 * `[math_env, zid]` (`updatePcaCache` stamps `expiration: Date.now() + 3000`).
 * A presented item is reused only while the cache item it was derived from is
 * still the identical object, which `getPca` guarantees for the same 3 s window,
 * and never past its own TTL. So a comment added, approved, or banned shows up in
 * the served blob within 3 s, as before. There is no comment-change invalidation
 * hook to reuse: `edge` had none either — its 3 s TTL *was* the invalidation.
 */

const PRESENTATION_TTL_MS = 3000;

type PresentationCacheEntry = {
  // Identity, not a copy: reuse only while `getPca` is still handing out the
  // very object this presentation was derived from.
  source: PcaCacheItem;
  presented: PcaCacheItem;
  expiration: number;
};

const presentationCacheSize = Config.cacheMathResults ? 300 : 1;
const presentationCache = new LruCache<string, PresentationCacheEntry>({
  max: presentationCacheSize,
});

function presentationCacheKey(mathEnv: string, zid: number): string {
  return JSON.stringify([mathEnv, zid]);
}

/**
 * The comment ids `edge` backfilled into an empty blob, from the predicate it
 * used (`server/src/utils/pca.ts` @ `origin/edge`, lines 152-207) — including its
 * behaviour on failure, which was to serve an empty list rather than to fail the
 * request.
 *
 * Note this predicate is `mod >= 1` and nothing else: it is not the participant
 * visibility predicate that `getComments`/`getCommentsCount` apply (`active`,
 * `velocity > 0`, strict/non-strict moderation), and it is not the report
 * predicate (`mod_gt = report.mod_level`). Those three differ, they differed
 * before this change, and unifying them is a separate, product-visible decision.
 */
async function backfilledTids(zid: number): Promise<number[]> {
  try {
    const commentsQuery = await pg.queryP_readOnly<Array<{ tid: number }>>(
      "select tid from comments where zid = ($1) and mod >= 1 order by tid",
      [zid]
    );

    if (commentsQuery && Array.isArray(commentsQuery)) {
      return commentsQuery.map((row: { tid: number }) => row.tid);
    }
  } catch (err) {
    logger.error("Error fetching comments for empty PCA structure", err);
  }
  return [];
}

function gzipP(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gzip(buf as unknown as InputType, (err: any, gzipped: any) => {
      if (err) {
        return reject(err);
      }
      resolve(gzipped);
    });
  });
}

/**
 * Wrap a `getPca` result in its served presentation.
 *
 * A pass-through for anything with real math: a blob that carries `tids`,
 * `n-cmts` and a `pca` object is returned as the identical object, and no query
 * is issued. `edge` ran the comments query on every cache miss and then discarded
 * its result for such blobs, so skipping it changes no bytes.
 */
export async function presentPca(
  zid: number | undefined,
  item: PcaCacheItem | undefined
): Promise<PcaCacheItem | undefined> {
  if (!item || !item.asPOJO || zid === undefined || zid === null) {
    return item;
  }

  const defaults = templateDefaultsFor(item.asPOJO);
  if (
    !defaults ||
    (!defaults.tids &&
      !defaults.nCmts &&
      !defaults.center &&
      !defaults.commentExtremity)
  ) {
    return item;
  }

  const mathEnv = Config.mathEnv;
  const key = presentationCacheKey(mathEnv, zid);
  const cached = presentationCache.get(key);
  if (cached && cached.source === item && cached.expiration > Date.now()) {
    return cached.presented;
  }

  // `center` is a constant, so only the other three need the database.
  const tids =
    defaults.tids || defaults.nCmts || defaults.commentExtremity
      ? await backfilledTids(zid)
      : [];

  // Spread rather than rebuild: every key keeps its position, so `asJSON` and its
  // gzip are byte-identical to what the same blob produced on `edge`.
  const asPOJO = { ...item.asPOJO, pca: { ...item.asPOJO.pca } };
  if (defaults.tids) {
    asPOJO.tids = tids;
  }
  if (defaults.nCmts) {
    asPOJO["n-cmts"] = tids.length;
  }
  if (defaults.center) {
    asPOJO.pca.center = [0, 0];
  }
  if (defaults.commentExtremity) {
    // One fabricated zero per comment, positionally aligned with the ids above.
    asPOJO.pca["comment-extremity"] = tids.map(() => 0);
  }

  const asJSON = JSON.stringify(asPOJO);
  const presented: PcaCacheItem = {
    ...item,
    asPOJO,
    asJSON,
    asBufferOfGzippedJson: await gzipP(Buffer.from(asJSON, "utf-8")),
  };

  presentationCache.set(key, {
    source: item,
    presented,
    expiration: Date.now() + PRESENTATION_TTL_MS,
  });

  return presented;
}
