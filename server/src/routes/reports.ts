import _ from "underscore";
import { failJson } from "../utils/fail";
import { generateTokenP } from "../auth";
import { isModerator } from "../utils/common";
import { sql_reports } from "../db/sql";
import pg from "../db/pg-query";

function handle_POST_reportCommentSelections(
  req: {
    p: { uid?: number; zid: number; rid: any; tid: number; include: any };
  },
  res: { json: (arg0: {}) => void }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;
  const rid = req.p.rid;
  const tid = req.p.tid;
  const selection = req.p.include ? 1 : -1;
  isModerator(zid, uid)
    .then((isMod: any) => {
      if (!isMod) {
        return failJson(
          res,
          403,
          "polis_err_POST_reportCommentSelections_auth"
        );
      }
      return pg
        .queryP(
          "insert into report_comment_selections (rid, tid, selection, zid, modified) values ($1, $2, $3, $4, now_as_millis()) " +
            "on conflict (rid, tid) do update set selection = ($3), zid  = ($4), modified = now_as_millis();",
          [rid, tid, selection, zid]
        )
        .then(() => {
          // The old report isn't valid anymore, so when a user loads the report again a new worker_tasks entry will be created.
          return pg.queryP(
            "delete from math_report_correlationmatrix where rid = ($1);",
            [rid]
          );
        })
        .then(() => {
          res.json({});
        });
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_POST_reportCommentSelections_misc", err);
    });
}

function createReport(zid: number) {
  return generateTokenP(20, false).then(function (report_id: string) {
    report_id = "r" + report_id;
    return pg.queryP("insert into reports (zid, report_id) values ($1, $2);", [
      zid,
      report_id,
    ]);
  });
}

function handle_POST_reports(
  req: { p: { zid: number; uid?: number } },
  res: { json: (arg0: {}) => void }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;

  return isModerator(zid, uid)
    .then((isMod: any) => {
      if (!isMod) {
        return failJson(res, 403, "polis_err_post_reports_permissions");
      }
      return createReport(zid).then(() => {
        res.json({});
      });
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_post_reports_misc", err);
    });
}

function handle_PUT_reports(
  req: {
    p: {
      [x: string]: any;
      rid: any;
      uid?: number;
      zid: number;
      report_name: any;
    };
  },
  res: { json: (arg0: {}) => void }
) {
  const rid = req.p.rid;
  const uid = req.p.uid;
  const zid = req.p.zid;

  return isModerator(zid, uid)
    .then((isMod: any) => {
      if (!isMod) {
        return failJson(res, 403, "polis_err_put_reports_permissions");
      }

      const fields: { [key: string]: string } = {
        modified: "now_as_millis()",
      };

      sql_reports.columns
        .map((c: { name: any }) => {
          return c.name;
        })
        .filter((name: string) => {
          // only allow changing label fields, (label_x_neg, etc) not zid, etc.
          return name.startsWith("label_");
        })
        .forEach((name: string | number) => {
          if (!_.isUndefined(req.p[name])) {
            fields[name] = req.p[name];
          }
        });

      if (!_.isUndefined(req.p.report_name)) {
        fields.report_name = req.p.report_name;
      }

      const q = sql_reports.update(fields).where(sql_reports.rid.equals(rid));

      let query = q.toString();
      query = query.replace("'now_as_millis()'", "now_as_millis()"); // remove quotes added by sql lib

      return pg.queryP(query, []).then(() => {
        res.json({});
      });
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_post_reports_misc", err);
    });
}

function handle_GET_reports(
  req: { p: { zid: number; rid: any; uid?: number } },
  res: { json: (arg0: any) => void }
) {
  const zid = req.p.zid;
  const rid = req.p.rid;
  const uid = req.p.uid;

  let reportsPromise = null;

  if (rid) {
    if (zid) {
      reportsPromise = Promise.reject(
        "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id"
      );
    } else {
      reportsPromise = pg.queryP("select * from reports where rid = ($1);", [
        rid,
      ]);
    }
  } else if (zid) {
    reportsPromise = isModerator(zid, uid).then((doesOwnConversation: any) => {
      if (!doesOwnConversation) {
        throw "polis_err_permissions";
      }
      return pg.queryP("select * from reports where zid = ($1);", [zid]);
    });
  } else {
    reportsPromise = pg.queryP(
      "select * from reports where zid in (select zid from conversations where owner = ($1));",
      [uid]
    );
  }

  reportsPromise
    .then((reports: any[]) => {
      const zids: number[] = [];
      reports = reports.map((report: { zid: number; rid: any }) => {
        zids.push(report.zid);
        delete report.rid;
        return report;
      });

      if (zids.length === 0) {
        return res.json(reports);
      }
      return pg
        .queryP(
          "select * from zinvites where zid in (" + zids.join(",") + ");",
          []
        )
        .then((zinvite_entries: any) => {
          const zidToZinvite = _.indexBy(zinvite_entries, "zid");
          reports = reports.map(
            (report: { conversation_id: any; zid?: string | number }) => {
              report.conversation_id = zidToZinvite[report.zid || ""]?.zinvite;
              delete report.zid;
              return report;
            }
          );
          res.json(reports);
        });
    })
    .catch((err: string) => {
      if (err === "polis_err_permissions") {
        failJson(res, 403, "polis_err_permissions");
      } else if (
        err ===
        "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id"
      ) {
        failJson(
          res,
          404,
          "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id"
        );
      } else {
        failJson(res, 500, "polis_err_get_reports_misc", err);
      }
    });
}

export {
  handle_GET_reports,
  handle_POST_reports,
  handle_PUT_reports,
  handle_POST_reportCommentSelections,
};
