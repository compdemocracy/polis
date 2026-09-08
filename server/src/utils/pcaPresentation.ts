// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import zlib, { InputType } from "zlib";
import LruCache from "lru-cache";
import Config from "../config";
import pg from "../db/pg-query";
import logger from "./logger";
import { PcaCacheItem, wasMergedWithTemplate } from "./pca";

/**
 * Served presentation of the math blob.
 *
 * The math engine emits an honest EMPTY result for a conversation with no votes:
 * no comment ids, no `n-cmts`, no `center`, no extremities (`polis-empty/1` in
 * P-022-G-engine-contract.md; `createEmptyPcaStructure` in ./pca.ts is now a
 * template of absences that matches it and asks the database nothing). That is
 * the engine-facing truth and what the certification golden pins.
 *
 * It is NOT what the API may serve. Until `edge`, the server filled the
 * conversation's comments into those fields inside the cached blob, and 2,884
 * production conversations plus every already-loaded client depend on the
 * resulting bytes. Changing the engine must not change them, so the fill moves
 * here: to the response boundary, after the cache.
 *
 * ## The predicate is the served shape, not where the value came from
 *
 * A field is filled when it is *absent or honestly empty*, whoever left it that
 * way. Both of these produce the same served bytes, which is the whole point:
 *
 *   - a legacy blob (none of the five production empty shapes carries `tids`,
 *     `n-cmts` or a `pca` key at all) leaves the merge's template value in
 *     place — `[]`, `0`, `[]`, `[]`, `{}`;
 *   - the corrected engine's `polis-empty/1` result declares those same fields
 *     explicitly, as `tids: []`, `n-cmts: 0`, `pca.center: []`,
 *     `pca["comment-extremity"]: []`, `pca["comment-projection"]: [[], []]`.
 *
 * An earlier revision keyed this on provenance (which fields the merge took from
 * its template). That preserved same-input behaviour but not the cutover: an
 * explicit empty from the engine is not a template default, so it bypassed the
 * fill and the conversation's comments dropped off the wire the moment the
 * engine changed. Provenance is also strictly weaker than the shape test — every
 * template value IS one of the empty values above — so the WeakMap is gone.
 *
 * What the mark that remains (`wasMergedWithTemplate`) is for: `getPca` merges
 * every `math_main` row, and the no-row fallback, against the template, and
 * `edge` did its backfill inside that same merge. `prefetchLatestPcaData` does
 * not merge — it puts raw blobs straight into the cache — and `edge` served
 * those unmodified. So does this. (That poller is disabled today,
 * `server.ts:114-115`.)
 *
 * ## What this does and does not preserve
 *
 * Preserved, byte for byte, against `origin/edge`:
 *   - the query is `edge`'s, verbatim, including its error fallback to an empty
 *     list rather than a failed request;
 *   - `center` is `edge`'s `[0, 0]` constant, `comment-extremity` is `edge`'s
 *     one-zero-per-comment, and `comment-projection` is `edge`'s `{}`;
 *   - the POJO is rebuilt by spreading, so every key keeps its position and the
 *     JSON — and the gzip of it — is unchanged, not merely equivalent.
 *
 * Not preserved, and not preservable at this layer: the *position* of
 * `mod-in` / `mod-out` / `meta-tids` in the served JSON across an engine
 * cutover. Those keys land wherever the incoming blob put them (the merge
 * appends the ones a blob omits, in guard order), so each of the five legacy
 * shapes already serves them in a different order. One presented order cannot
 * equal all five, and same-input byte identity fixes it to the input's. Their
 * VALUES are unaffected. See the C7 report, "Revision 2".
 *
 * ## Freshness
 *
 * Matches `edge` exactly rather than approximately. `edge` re-ran the backfill
 * inside `getPca` on every cache miss, i.e. at most once per 3 s per
 * `[math_env, zid]` (`updatePcaCache` stamps `expiration: Date.now() + 3000`).
 * A presented item is reused only while the cache item it was derived from is
 * still the identical object, which `getPca` guarantees for the same 3 s window,
 * and never past its own TTL. So a comment added, approved, or banned shows up
 * in the served blob within 3 s, as before. There is no comment-change
 * invalidation hook to reuse: `edge` had none either — its 3 s TTL *was* the
 * invalidation.
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

/**
 * "The math holds no comments here": absent, not a list at all, or an empty one.
 * Covers the legacy shapes' missing keys and `polis-empty/1`'s explicit `[]`.
 */
function noComments(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0;
}

/** Same, for `n-cmts`: absent, not a number, or zero. */
function noCommentCount(value: unknown): boolean {
  return typeof value !== "number" || value === 0;
}

/**
 * Same, for `comment-projection`, whose empty representation differs by
 * producer: absent on the legacy shapes (the template's `{}` stands), and
 * `[[], []]` from the corrected engine. `{}` itself is already the served value,
 * so it needs no rewrite. A projection with any coordinate in it is real math.
 */
function noProjection(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) &&
      value.every((column) => Array.isArray(column) && column.length === 0))
  );
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
 * A pass-through for anything with real math: a blob whose `tids`, `n-cmts` and
 * `pca` describe actual comments is returned as the identical object, and no
 * query is issued. `edge` ran the comments query on every cache miss and then
 * discarded its result for such blobs, so skipping it changes no bytes.
 */
export async function presentPca(
  zid: number | undefined,
  item: PcaCacheItem | undefined
): Promise<PcaCacheItem | undefined> {
  if (!item || !item.asPOJO || zid === undefined || zid === null) {
    return item;
  }
  if (!wasMergedWithTemplate(item.asPOJO)) {
    return item;
  }

  const pojo = item.asPOJO;
  const pca = pojo.pca || ({} as PcaCacheItem["asPOJO"]["pca"]);
  const fill = {
    tids: noComments(pojo.tids),
    nCmts: noCommentCount(pojo["n-cmts"]),
    center: noComments(pca.center),
    commentExtremity: noComments(pca["comment-extremity"]),
    commentProjection: noProjection(pca["comment-projection"]),
  };
  if (!Object.values(fill).some(Boolean)) {
    return item;
  }

  const mathEnv = Config.mathEnv;
  const key = presentationCacheKey(mathEnv, zid);
  const cached = presentationCache.get(key);
  if (cached && cached.source === item && cached.expiration > Date.now()) {
    return cached.presented;
  }

  // `center` and `comment-projection` are constants, so only the other three
  // need the database.
  const tids =
    fill.tids || fill.nCmts || fill.commentExtremity
      ? await backfilledTids(zid)
      : [];

  // Spread rather than rebuild: every key keeps its position, so `asJSON` and its
  // gzip are byte-identical to what the same blob produced on `edge`.
  const asPOJO = { ...pojo, pca: { ...pca } };
  if (fill.tids) {
    asPOJO.tids = tids;
  }
  if (fill.nCmts) {
    asPOJO["n-cmts"] = tids.length;
  }
  if (fill.center) {
    asPOJO.pca.center = [0, 0];
  }
  if (fill.commentExtremity) {
    // One fabricated zero per comment, positionally aligned with the ids above.
    asPOJO.pca["comment-extremity"] = tids.map(() => 0);
  }
  if (fill.commentProjection) {
    asPOJO.pca["comment-projection"] = {};
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
