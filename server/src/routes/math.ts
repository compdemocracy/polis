import _ from "underscore";
import { getPca, PcaCacheItem } from "../utils/pca";
import { failJson } from "../utils/fail";
import pg from "../db/pg-query";
import Utils from "../utils/common";
import { getZidForRid } from "../utils/zinvite";
import { getBidIndexToPidMapping } from "../utils/participants";
import Config from "../config";
import logger from "../utils/logger";
import { getPidPromise } from "../user";

function handle_GET_math_pca(
  req: any,
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      end: { (): void; new (): any };
    };
  }
) {
  // migrated off this path, old clients were causing timeout issues by polling
  // repeatedly without waiting for a result for a previous poll.
  res.status(304).end();
}

// Cache the knowledge of whether there are any pca results for a given zid.
// Needed to determine whether to return a 404 or a 304.
// zid -> boolean
const pcaResultsExistForZid: Record<number, boolean> = {};

function handle_GET_math_pca2(
  req: { p: { zid: number; math_tick: any; ifNoneMatch: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      end: { (): void; new (): any };
    };
    set: (arg0: {
      "Content-Type": string;
      "Content-Encoding": string;
      Etag: string;
    }) => void;
    send: (arg0: any) => void;
  }
) {
  const zid = req.p.zid;
  let math_tick = req.p.math_tick;

  const ifNoneMatch = req.p.ifNoneMatch;
  if (ifNoneMatch) {
    if (math_tick !== undefined) {
      return failJson(
        res,
        400,
        "Expected either math_tick param or If-Not-Match header, but not both."
      );
    }
    if (ifNoneMatch.includes("*")) {
      math_tick = 0;
    } else {
      const entries = ifNoneMatch.split(/ *, */).map((x: string) => {
        return Number(
          x
            .replace(/^[wW]\//, "")
            .replace(/^"/, "")
            .replace(/"$/, "")
        );
      });
      math_tick = Math.min(...entries);
    }
  } else if (math_tick === undefined) {
    math_tick = -1;
  }

  function finishWith304or404() {
    if (pcaResultsExistForZid[zid]) {
      res.status(304).end();
    } else {
      // Technically, this should probably be a 404, but
      // the red errors make it hard to see other errors
      // in Chrome Developer Tools.
      res.status(304).end();
      // res.status(404).end();
    }
  }

  getPca(zid, math_tick)
    .then(function (data: PcaCacheItem | undefined) {
      if (data) {
        // The buffer is gzipped beforehand to cut down on server effort in re-gzipping
        // the same json string for each response.
        // We can't cache this endpoint on Cloudflare because the response changes too freqently,
        // so it seems like the best way is to cache the gzipped json'd buffer here on the server.
        res.set({
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          Etag: '"' + data.asPOJO.math_tick + '"',
        });
        res.send(data.asBufferOfGzippedJson);
      } else {
        // check whether we should return a 304 or a 404
        if (pcaResultsExistForZid[zid] === undefined) {
          // This server doesn't know yet if there are any PCA results in the DB
          // So try querying from -1
          return getPca(zid, -1).then(function (data: any) {
            const exists = !!data;
            pcaResultsExistForZid[zid] = exists;
            finishWith304or404();
          });
        } else {
          finishWith304or404();
        }
      }
    })
    .catch(function (err: any) {
      failJson(res, 500, err);
    });
}

function handle_POST_math_update(
  req: { p: { zid: number; uid?: number; math_update_type: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const math_env = Config.mathEnv;
  const math_update_type = req.p.math_update_type;

  Utils.isModerator(zid, uid).then((hasPermission: any) => {
    if (!hasPermission) {
      return failJson(res, 500, "handle_POST_math_update_permission");
    }
    return pg
      .queryP(
        "insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('update_math', $1, $2, $3);",
        [
          JSON.stringify({
            zid: zid,
            math_update_type: math_update_type,
          }),
          zid,
          math_env,
        ]
      )
      .then(() => {
        res.status(200).json({});
      })
      .catch((err: any) => {
        return failJson(res, 500, "polis_err_POST_math_update", err);
      });
  });
}

function handle_GET_math_correlationMatrix(
  req: { p: { rid: any; math_tick: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: { status: string }): void; new (): any };
    };
    json: (arg0: any) => void;
  }
) {
  const rid = req.p.rid;
  const math_env = Config.mathEnv;
  const math_tick = req.p.math_tick;

  function finishAsPending() {
    res.status(202).json({
      status: "pending",
    });
  }

  function hasCommentSelections() {
    return pg
      .queryP(
        "select * from report_comment_selections where rid = ($1) and selection = 1;",
        [rid]
      )
      .then((rows: string | any[]) => {
        return rows.length > 0;
      });
  }

  const requestExistsPromise = pg.queryP(
    "select * from worker_tasks where task_type = 'generate_report_data' and math_env=($2) " +
      "and task_bucket = ($1) " +
      // "and attempts < 3 " +
      "and (task_data->>'math_tick')::int >= ($3) " +
      "and finished_time is NULL;",
    [rid, math_env, math_tick]
  );

  const resultExistsPromise = pg.queryP(
    "select * from math_report_correlationmatrix where rid = ($1) and math_env = ($2) and math_tick >= ($3);",
    [rid, math_env, math_tick]
  );

  Promise.all([resultExistsPromise, getZidForRid(rid)])
    .then((a: any[]) => {
      const rows = a[0];
      const zid = a[1];
      if (!rows || !rows.length) {
        return requestExistsPromise.then((requests_rows: string | any[]) => {
          const shouldAddTask = !requests_rows || !requests_rows.length;
          // const shouldAddTask = true;

          if (shouldAddTask) {
            return hasCommentSelections().then((hasSelections: any) => {
              if (!hasSelections) {
                return res.status(202).json({
                  status: "polis_report_needs_comment_selection",
                });
              }
              return pg
                .queryP(
                  "insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('generate_report_data', $1, $2, $3);",
                  [
                    JSON.stringify({
                      rid: rid,
                      zid: zid,
                      math_tick: math_tick,
                    }),
                    rid,
                    math_env,
                  ]
                )
                .then(finishAsPending);
            });
          }
          finishAsPending();
        });
      }
      res.json(rows[0].data);
    })
    .catch((err: any) => {
      return failJson(res, 500, "polis_err_GET_math_correlationMatrix", err);
    });
}

function handle_GET_bidToPid(
  req: { p: { zid: number; math_tick: any } },
  res: {
    json: (arg0: { bidToPid: any }) => void;
    status: (arg0: number) => {
      (): any;
      new (): any;
      end: { (): void; new (): any };
    };
  }
) {
  const zid = req.p.zid;
  const math_tick = req.p.math_tick;
  getBidIndexToPidMapping(zid, math_tick).then(
    function (doc: { bidToPid: any }) {
      const b2p = doc.bidToPid;
      res.json({
        bidToPid: b2p,
      });
    },
    function () {
      res.status(304).end();
    }
  );
}

function getBidsForPids(zid: number, math_tick: number, pids: number[]) {
  const dataPromise = getBidIndexToPidMapping(zid, math_tick);
  const mathResultsPromise = getPca(zid, math_tick);

  return Promise.all([dataPromise, mathResultsPromise]).then(function (
    items: { asPOJO: any; bidToPid: any }[]
  ) {
    const b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
    const mathResults = items[1].asPOJO;
    function findBidForPid(pid: number) {
      let yourBidi = -1;
      // if (!b2p) {
      //     return yourBidi;
      // }
      for (let bidi = 0; bidi < b2p.length; bidi++) {
        const pids = b2p[bidi];
        if (pids.indexOf(pid) !== -1) {
          yourBidi = bidi;
          break;
        }
      }

      let yourBid = indexToBid[yourBidi];

      if (yourBidi >= 0 && _.isUndefined(yourBid)) {
        logger.error("polis_err_math_index_mapping_mismatch", { pid, b2p });
        yourBid = -1;
      }
      return yourBid;
    }

    const indexToBid = mathResults["base-clusters"].id;
    const bids = pids.map(findBidForPid);
    const pidToBid = _.object(pids, bids);
    return pidToBid;
  });
}

function handle_GET_bid(
  req: { p: { uid?: number; zid: number; math_tick: any } },
  res: {
    json: (arg0: { bid: any }) => void;
    status: (arg0: number) => {
      (): any;
      new (): any;
      end: { (): void; new (): any };
    };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;
  const math_tick = req.p.math_tick;

  const dataPromise = getBidIndexToPidMapping(zid, math_tick);
  const pidPromise = getPidPromise(zid, uid);
  const mathResultsPromise = getPca(zid, math_tick);

  Promise.all([dataPromise, pidPromise, mathResultsPromise])
    .then(
      function (items: { asPOJO: any; bidToPid: any }[]) {
        const b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
        const pid = items[1];
        const mathResults = items[2].asPOJO;
        if ((pid as unknown as number) < 0) {
          // NOTE: this API should not be called in /demo mode
          failJson(res, 500, "polis_err_get_bid_bad_pid");
          return;
        }

        const indexToBid = mathResults["base-clusters"].id;

        let yourBidi = -1;
        for (let bidi = 0; bidi < b2p.length; bidi++) {
          const pids = b2p[bidi];
          if (pids.indexOf(pid) !== -1) {
            yourBidi = bidi;
            break;
          }
        }

        let yourBid = indexToBid[yourBidi];

        if (yourBidi >= 0 && _.isUndefined(yourBid)) {
          logger.error("polis_err_math_index_mapping_mismatch", { pid, b2p });
          yourBid = -1;
        }

        res.json({
          bid: yourBid, // The user's current bid
        });
      },
      function () {
        res.status(304).end();
      }
    )
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_get_bid_misc", err);
    });
}

export {
  getBidsForPids,
  handle_GET_bid,
  handle_GET_bidToPid,
  handle_GET_math_correlationMatrix,
  handle_GET_math_pca,
  handle_GET_math_pca2,
  handle_POST_math_update,
};
