import { getPca, PcaCacheItem } from "../utils/pca";
import fail from "../utils/fail";
import { queryP as pgQueryP } from "../db/pg-query";
import Utils from "../utils/common";
import { getZidForRid } from "../utils/zinvite";

import Config from "../config";

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

export {
  handle_GET_math_pca,
  handle_GET_math_pca2,
  handle_POST_math_update,
  handle_GET_math_correlationMatrix,
};
