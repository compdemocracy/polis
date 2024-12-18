import { query as pgQuery } from "../db/pg-query";
import Utils from "../utils/common";
import fail from "../utils/fail";

function getZidForAnswer(
  pmaid: any,
  callback: {
    (err: any, zid: any): void;
    (arg0: string | null, arg1?: undefined): void;
  }
) {
  pgQuery(
    "SELECT zid FROM participant_metadata_answers WHERE pmaid = ($1);",
    [pmaid],
    function (err: any, result: { rows: string | any[] }) {
      if (err) {
        callback(err);
        return;
      }
      if (!result.rows || !result.rows.length) {
        callback("polis_err_zid_missing_for_answer");
        return;
      }
      callback(null, result.rows[0].zid);
    }
  );
}

function deleteMetadataAnswer(
  pmaid: any,
  callback: { (err: any): void; (arg0: null): void }
) {
  pgQuery(
    "update participant_metadata_answers set alive = FALSE where pmaid = ($1);",
    [pmaid],
    function (err: any) {
      if (err) {
        callback(err);
        return;
      }
      callback(null);
    }
  );
}

function handle_DELETE_metadata_answers(
  req: { p: { uid?: any; pmaid: any } },
  res: { send: (arg0: number) => void }
) {
  let uid = req.p.uid;
  let pmaid = req.p.pmaid;

  getZidForAnswer(pmaid, function (err: any, zid: any) {
    if (err) {
      fail(res, 500, "polis_err_delete_participant_metadata_answers_zid", err);
      return;
    }
    Utils.isConversationOwner(zid, uid, function (err: any) {
      if (err) {
        fail(
          res,
          403,
          "polis_err_delete_participant_metadata_answers_auth",
          err
        );
        return;
      }

      deleteMetadataAnswer(pmaid, function (err: any) {
        if (err) {
          fail(res, 500, "polis_err_delete_participant_metadata_answers", err);
          return;
        }
        res.send(200);
      });
    });
  });
}

export default handle_DELETE_metadata_answers;
