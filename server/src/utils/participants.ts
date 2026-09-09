import pg from "../db/pg-query";
import Config from "../config";
import { getMathBundle, pidsForGid } from "./mathBundle";

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

/**
 * The participants of one group.
 *
 * This used to be `Promise.all([getPca(...), getBidIndexToPidMapping(...)])`:
 * two statements, two snapshots, and a publication landing between them
 * produced an old `base-clusters.id` indexed with a new `bidToPid`. Base
 * cluster ids are reused across generations, so that torn join returned a
 * plausible but wrong participant list rather than an error.
 *
 * It now reads one immutable Bundle and joins inside it. The observable
 * results are unchanged for every coherent generation; the outcomes that used
 * to be reachable only by tearing are gone.
 *
 * `[]` is returned when there is no math, when the Bundle fails admission, and
 * when the requested generation is not newer -- the same empty answer the
 * two-read version produced in each of those cases.
 */
export async function getPidsForGid(
  zid: number,
  gid: number,
  math_tick: number
): Promise<number[]> {
  // `undefined` meant "latest" to both of the previous reads: `getPca` floors
  // an absent tick at -1 and `getBidIndexToPidMapping` does `math_tick || -1`.
  const requested = typeof math_tick === "number" ? math_tick : -1;
  const read = await getMathBundle(zid);
  if (!read.present || !read.admitted) {
    return [];
  }
  if (read.bundle.mathTick <= requested) {
    return [];
  }
  return pidsForGid(read.bundle, gid);
}
