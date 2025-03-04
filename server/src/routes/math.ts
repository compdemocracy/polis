import _ from "underscore";
import { getPca, PcaCacheItem } from "../utils/pca";
import { MPromise } from "../utils/metered";
import fail from "../utils/fail";
import { queryP as pgQueryP, query_readOnly as pgQuery_readOnly } from "../db/pg-query";
import Utils from "../utils/common";
import { getZidForRid } from "../utils/zinvite";
import { getBidIndexToPidMapping } from "../utils/participants";

import Config from "../config";
import logger from "../utils/logger";
import User from "../user";

function handle_GET_math_pca(
  req: any,
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; end: { (): void; new (): any } };
  }
) {
  // migrated off this path, old clients were causing timeout issues by polling repeatedly without waiting for a result for a previous poll.
  res.status(304).end();
}

// Cache the knowledge of whether there are any pca results for a given zid.
// Needed to determine whether to return a 404 or a 304.
// zid -> boolean
const pcaResultsExistForZid = {};

const getPidPromise = User.getPidPromise;

function handle_GET_math_pca2(
  req: { p: { zid: any; math_tick: any; ifNoneMatch: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; end: { (): void; new (): any } };
    set: (arg0: {
      "Content-Type": string;
      "Content-Encoding": string;
      Etag: string;
    }) => void;
    send: (arg0: any) => void;
  }
) {
  let zid = req.p.zid;
  let math_tick = req.p.math_tick;

  let ifNoneMatch = req.p.ifNoneMatch;
  if (ifNoneMatch) {
    if (math_tick !== undefined) {
      return fail(
        res,
        400,
        "Expected either math_tick param or If-Not-Match header, but not both."
      );
    }
    if (ifNoneMatch.includes("*")) {
      math_tick = 0;
    } else {
      let entries = ifNoneMatch.split(/ *, */).map((x: string) => {
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
    // Element implicitly has an 'any' type
    // because expression of type 'any' can't be used to index type '{ } '.ts(7053)
    // @ts-ignore
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
        // The buffer is gzipped beforehand to cut down on server effort in re-gzipping the same json string for each response.
        // We can't cache this endpoint on Cloudflare because the response changes too freqently, so it seems like the best way
        // is to cache the gzipped json'd buffer here on the server.
        res.set({
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          Etag: '"' + data.asPOJO.math_tick + '"',
        });
        res.send(data.asBufferOfGzippedJson);
      } else {
        // check whether we should return a 304 or a 404
        // Element implicitly has an 'any' type
        // because expression of type 'any' can't be used to index type '{ } '.ts(7053)
        // @ts-ignore
        if (pcaResultsExistForZid[zid] === undefined) {
          // This server doesn't know yet if there are any PCA results in the DB
          // So try querying from -1
          return getPca(zid, -1).then(function (data: any) {
            let exists = !!data;
            // Element implicitly has an 'any' type
            // because expression of type 'any' can't be used to index type '{ } '.ts(7053)
            // @ts-ignore
            pcaResultsExistForZid[zid] = exists;
            finishWith304or404();
          });
        } else {
          finishWith304or404();
        }
      }
    })
    .catch(function (err: any) {
      fail(res, 500, err);
    });
}

function handle_POST_math_update(
  req: { p: { zid: any; uid?: any; math_update_type: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  let zid = req.p.zid;
  let uid = req.p.uid;
  let math_env = Config.mathEnv;
  let math_update_type = req.p.math_update_type;

  Utils.isModerator(zid, uid).then((hasPermission: any) => {
    if (!hasPermission) {
      return fail(res, 500, "handle_POST_math_update_permission");
    }
    return pgQueryP(
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
        return fail(res, 500, "polis_err_POST_math_update", err);
      });
  });
}

function handle_GET_math_correlationMatrix(
  req: { p: { rid: any; math_tick: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: { status: string }): void; new (): any };
    };
    json: (arg0: any) => void;
  }
) {
  let rid = req.p.rid;
  let math_env = Config.mathEnv;
  let math_tick = req.p.math_tick;

  function finishAsPending() {
    res.status(202).json({
      status: "pending",
    });
  }

  function hasCommentSelections() {
    return pgQueryP(
      "select * from report_comment_selections where rid = ($1) and selection = 1;",
      [rid]
      // Argument of type '(rows: string | any[]) => boolean' is not assignable to parameter of type '(value: unknown) => boolean | PromiseLike<boolean>'.
      // Types of parameters 'rows' and 'value' are incompatible.
      // Type 'unknown' is not assignable to type 'string | any[]'.
      //     Type 'unknown' is not assignable to type 'any[]'.ts(2345)
      // @ts-ignore
    ).then((rows: string | any[]) => {
      return rows.length > 0;
    });
  }

  let requestExistsPromise = pgQueryP(
    "select * from worker_tasks where task_type = 'generate_report_data' and math_env=($2) " +
      "and task_bucket = ($1) " +
      // "and attempts < 3 " +
      "and (task_data->>'math_tick')::int >= ($3) " +
      "and finished_time is NULL;",
    [rid, math_env, math_tick]
  );

  let resultExistsPromise = pgQueryP(
    "select * from math_report_correlationmatrix where rid = ($1) and math_env = ($2) and math_tick >= ($3);",
    [rid, math_env, math_tick]
  );

  Promise.all([resultExistsPromise, getZidForRid(rid)])
    .then((a: any[]) => {
      let rows = a[0];
      let zid = a[1];
      if (!rows || !rows.length) {
        //         Argument of type '(requests_rows: string | any[]) => globalThis.Promise<void> | undefined' is not assignable to parameter of type '(value: unknown) => void | PromiseLike<void | undefined> | undefined'.
        // Types of parameters 'requests_rows' and 'value' are incompatible.
        //   Type 'unknown' is not assignable to type 'string | any[]'.
        //           Type 'unknown' is not assignable to type 'any[]'.ts(2345)
        // @ts-ignore
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
              return pgQueryP(
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
              ).then(finishAsPending);
            });
          }
          finishAsPending();
        });
      }
      res.json(rows[0].data);
    })
    .catch((err: any) => {
      return fail(res, 500, "polis_err_GET_math_correlationMatrix", err);
    });
}

function handle_GET_bidToPid(
  req: { p: { zid: any; math_tick: any } },
  res: {
    json: (arg0: { bidToPid: any }) => void;
    status: (
      arg0: number
    ) => { (): any; new (): any; end: { (): void; new (): any } };
  }
) {
  let zid = req.p.zid;
  let math_tick = req.p.math_tick;
  getBidIndexToPidMapping(zid, math_tick).then(
    function (doc: { bidToPid: any }) {
      let b2p = doc.bidToPid;
      res.json({
        bidToPid: b2p,
      });
    },
    function (err: any) {
      res.status(304).end();
    }
  );
}


function getXids(zid: number): Promise<{ pid: number, xid: string }[] | undefined> {
  return MPromise(
    "getXids",
    function (resolve: (arg0: { pid: number, xid: string }[]) => void, reject: (arg0: string) => void) {
      pgQuery_readOnly(
        "select pid, xid from xids inner join " +
          "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
          " where owner in (select org_id from conversations where zid = ($1));",
        [zid],
        function (err: any, result: { rows: { pid: number, xid: string }[] }) {
          if (err) {
            reject("polis_err_fetching_xids");
            return;
          }
          resolve(result.rows);
        }
      );
    }
  ) as Promise<{ pid: number, xid: string }[] | undefined>;
}

function handle_GET_xids(
  req: { p: { uid?: any; zid: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  let uid = req.p.uid;
  let zid = req.p.zid;

  Utils.isOwner(zid, uid).then(
    function (owner: any) {
      if (owner) {
        getXids(zid).then(
          function (xids: any) {
            res.status(200).json(xids);
          },
          function (err: any) {
            fail(res, 500, "polis_err_get_xids", err);
          }
        );
      } else {
        fail(res, 403, "polis_err_get_xids_not_authorized");
      }
    },
    function (err: any) {
      fail(res, 500, "polis_err_get_xids", err);
    }
  );
}

function handle_POST_xidWhitelist(
  req: { p: { xid_whitelist: any; uid?: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const xid_whitelist = req.p.xid_whitelist;
  const len = xid_whitelist.length;
  const owner = req.p.uid;
  const entries = [];
  try {
    for (var i = 0; i < len; i++) {
      entries.push("(" + Utils.escapeLiteral(xid_whitelist[i]) + "," + owner + ")");
    }
  } catch (err) {
    return fail(res, 400, "polis_err_bad_xid", err);
  }

  pgQueryP(
    "insert into xid_whitelist (xid, owner) values " +
      entries.join(",") +
      " on conflict do nothing;",
    []
  )
    .then((result: any) => {
      res.status(200).json({});
    })
    .catch((err: any) => {
      return fail(res, 500, "polis_err_POST_xidWhitelist", err);
    });
}

function getBidsForPids(zid: any, math_tick: number, pids: any[]) {
  let dataPromise = getBidIndexToPidMapping(zid, math_tick);
  let mathResultsPromise = getPca(zid, math_tick);

  return Promise.all([dataPromise, mathResultsPromise]).then(function (
    items: { asPOJO: any }[]
  ) {
    // Property 'bidToPid' does not exist on type '{ asPOJO: any; }'.ts(2339)
    // @ts-ignore
    let b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
    let mathResults = items[1].asPOJO;
    function findBidForPid(pid: any) {
      let yourBidi = -1;
      // if (!b2p) {
      //     return yourBidi;
      // }
      for (var bidi = 0; bidi < b2p.length; bidi++) {
        let pids = b2p[bidi];
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

    let indexToBid = mathResults["base-clusters"].id;
    let bids = pids.map(findBidForPid);
    let pidToBid = _.object(pids, bids);
    return pidToBid;
  });
}

function handle_GET_bid(
  req: { p: { uid?: any; zid: any; math_tick: any } },
  res: {
    json: (arg0: { bid: any }) => void;
    status: (
      arg0: number
    ) => { (): any; new (): any; end: { (): void; new (): any } };
  }
) {
  let uid = req.p.uid;
  let zid = req.p.zid;
  let math_tick = req.p.math_tick;

  let dataPromise = getBidIndexToPidMapping(zid, math_tick);
  let pidPromise = getPidPromise(zid, uid);
  let mathResultsPromise = getPca(zid, math_tick);

  Promise.all([dataPromise, pidPromise, mathResultsPromise])
    .then(
      function (items: { asPOJO: any }[]) {
        // Property 'bidToPid' does not exist on type '{ asPOJO: any; }'.ts(2339)
        // @ts-ignore
        let b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
        let pid = items[1];
        let mathResults = items[2].asPOJO;
        if (((pid as unknown) as number) < 0) {
          // NOTE: this API should not be called in /demo mode
          fail(res, 500, "polis_err_get_bid_bad_pid");
          return;
        }

        let indexToBid = mathResults["base-clusters"].id;

        let yourBidi = -1;
        for (var bidi = 0; bidi < b2p.length; bidi++) {
          let pids = b2p[bidi];
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
      function (err: any) {
        res.status(304).end();
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_get_bid_misc", err);
    });
}

export {
  handle_GET_math_pca,
  handle_GET_math_pca2,
  handle_POST_math_update,
  handle_GET_math_correlationMatrix,
  handle_GET_bidToPid,
  getXids,
  handle_GET_xids,
  handle_POST_xidWhitelist,
  getBidsForPids,
  handle_GET_bid
};
