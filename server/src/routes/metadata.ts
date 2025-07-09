import pg from "../db/pg-query";
import Utils, { isConversationOwner } from "../utils/common";
import { failJson } from "../utils/fail";
import logger from "../utils/logger";
import { finishArray, finishOne } from "../server-helpers";
import { sql_participant_metadata_answers } from "../db/sql";
import async from "async";

function getZidForAnswer(
  pmaid: any,
  callback: {
    (err: any, zid: number): void;
    (arg0: string | null, arg1?: undefined): void;
  }
) {
  pg.query(
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
  pg.query(
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
  req: { p: { uid?: number; pmaid: any } },
  res: any
) {
  const uid = req.p.uid;
  const pmaid = req.p.pmaid;

  getZidForAnswer(pmaid, function (err: any, zid: number) {
    if (err) {
      failJson(
        res,
        500,
        "polis_err_delete_participant_metadata_answers_zid",
        err
      );
      return;
    }
    Utils.isConversationOwner(zid, uid, function (err: any) {
      if (err) {
        failJson(
          res,
          403,
          "polis_err_delete_participant_metadata_answers_auth",
          err
        );
        return;
      }

      deleteMetadataAnswer(pmaid, function (err: any) {
        if (err) {
          failJson(
            res,
            500,
            "polis_err_delete_participant_metadata_answers",
            err
          );
          return;
        }
        res.status(200).json({ success: true });
      });
    });
  });
}

function getZidForQuestion(
  pmqid: any,
  callback: {
    (err: any, zid?: number): void;
    (arg0: string | null, arg1: undefined): void;
  }
) {
  pg.query(
    "SELECT zid FROM participant_metadata_questions WHERE pmqid = ($1);",
    [pmqid],
    function (err: any, result: { rows: string | any[] }) {
      if (err) {
        logger.error("polis_err_zid_missing_for_question", err);
        callback(err);
        return;
      }
      if (!result.rows || !result.rows.length) {
        callback("polis_err_zid_missing_for_question");
        return;
      }
      callback(null, result.rows[0].zid);
    }
  );
}

function deleteMetadataQuestionAndAnswers(
  pmqid: any,
  callback: { (err: any): void; (arg0: null): void }
) {
  pg.query(
    "update participant_metadata_answers set alive = FALSE where pmqid = ($1);",
    [pmqid],
    function (err: any) {
      if (err) {
        callback(err);
        return;
      }
      pg.query(
        "update participant_metadata_questions set alive = FALSE where pmqid = ($1);",
        [pmqid],
        function (err: any) {
          if (err) {
            callback(err);
            return;
          }
          callback(null);
        }
      );
    }
  );
}

function handle_DELETE_metadata_questions(
  req: { p: { uid?: number; pmqid: any } },
  res: any
) {
  const uid = req.p.uid;
  const pmqid = req.p.pmqid;

  getZidForQuestion(pmqid, function (err: any, zid: number) {
    if (err) {
      failJson(
        res,
        500,
        "polis_err_delete_participant_metadata_questions_zid",
        err
      );
      return;
    }
    isConversationOwner(zid, uid, function (err: any) {
      if (err) {
        failJson(
          res,
          403,
          "polis_err_delete_participant_metadata_questions_auth",
          err
        );
        return;
      }

      deleteMetadataQuestionAndAnswers(pmqid, function (err?: string | null) {
        if (err) {
          failJson(
            res,
            500,
            "polis_err_delete_participant_metadata_question",
            new Error(err)
          );
          return;
        }
        res.status(200).json({ success: true });
      });
    });
  });
}

function getChoicesForConversation(zid: number) {
  return new Promise(function (
    resolve: (arg0: never[]) => void,
    reject: (arg0: any) => void
  ) {
    pg.query_readOnly(
      "select * from participant_metadata_choices where zid = ($1) and alive = TRUE;",
      [zid],
      function (err: any, x: { rows: any }) {
        if (err) {
          reject(err);
          return;
        }
        if (!x || !x.rows) {
          resolve([]);
          return;
        }
        resolve(x.rows);
      }
    );
  });
}

function checkZinviteCodeValidity(
  zid: number,
  zinvite: string,
  callback: (err: number | null) => void
) {
  pg.query_readOnly(
    "SELECT * FROM zinvites WHERE zid = ($1) AND zinvite = ($2);",
    [zid, zinvite],
    function (err: any, results: { rows: string | any[] }) {
      if (err || !results || !results.rows || !results.rows.length) {
        callback(1);
      } else {
        callback(null); // ok
      }
    }
  );
}

function checkSuzinviteCodeValidity(
  zid: number,
  suzinvite: string,
  callback: (err: number | null) => void
) {
  pg.query(
    "SELECT * FROM suzinvites WHERE zid = ($1) AND suzinvite = ($2);",
    [zid, suzinvite],
    function (err: any, results: { rows: string | any[] }) {
      if (err || !results || !results.rows || !results.rows.length) {
        callback(1);
      } else {
        callback(null); // ok
      }
    }
  );
}

function handle_GET_metadata_questions(
  req: { p: { zid: number; zinvite: string; suzinvite: any } },
  res: any
) {
  const zid = req.p.zid;
  const zinvite = req.p.zinvite;
  const suzinvite = req.p.suzinvite;

  function doneChecking(err: number | null) {
    if (err) {
      failJson(res, 403, "polis_err_get_participant_metadata_auth", err);
      return;
    }

    async.parallel(
      [
        function (callback: any) {
          pg.query_readOnly(
            "SELECT * FROM participant_metadata_questions WHERE alive = true AND zid = ($1);",
            [zid],
            callback
          );
        },
      ],
      function (err: any, result: { rows: any }[]) {
        if (err) {
          failJson(
            res,
            500,
            "polis_err_get_participant_metadata_questions",
            err
          );
          return;
        }
        let rows = result[0] && result[0].rows;
        rows = rows.map(function (r: { required: boolean }) {
          r.required = true;
          return r;
        });
        finishArray(res, rows);
      }
    );
  }

  if (zinvite) {
    checkZinviteCodeValidity(zid, zinvite, doneChecking);
  } else if (suzinvite) {
    checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
  } else {
    doneChecking(null);
  }
}

function handle_POST_metadata_questions(
  req: { p: { zid: number; key: any; uid?: number } },
  res: any
) {
  const zid = req.p.zid;
  const key = req.p.key;
  const uid = req.p.uid;

  function doneChecking(err: any) {
    if (err) {
      failJson(res, 403, "polis_err_post_participant_metadata_auth", err);
      return;
    }
    pg.query(
      "INSERT INTO participant_metadata_questions (pmqid, zid, key) VALUES (default, $1, $2) RETURNING *;",
      [zid, key],
      function (err: any, results: { rows: string | any[] }) {
        if (err || !results || !results.rows || !results.rows.length) {
          failJson(res, 500, "polis_err_post_participant_metadata_key", err);
          return;
        }

        finishOne(res, results.rows[0]);
      }
    );
  }

  isConversationOwner(zid, uid, doneChecking);
}

function handle_POST_metadata_answers(
  req: { p: { zid: number; uid?: number; pmqid: any; value: any } },
  res: any
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const pmqid = req.p.pmqid;
  const value = req.p.value;

  function doneChecking(err: any) {
    if (err) {
      failJson(res, 403, "polis_err_post_participant_metadata_auth", err);
      return;
    }
    pg.query(
      "INSERT INTO participant_metadata_answers (pmqid, zid, value, pmaid) VALUES ($1, $2, $3, default) RETURNING *;",
      [pmqid, zid, value],
      function (err: any, results: { rows: string | any[] }) {
        if (err || !results || !results.rows || !results.rows.length) {
          pg.query(
            "UPDATE participant_metadata_answers set alive = TRUE where pmqid = ($1) AND zid = ($2) AND value = ($3) RETURNING *;",
            [pmqid, zid, value],
            function (err: any, results: { rows: any[] }) {
              if (err) {
                failJson(
                  res,
                  500,
                  "polis_err_post_participant_metadata_value",
                  err
                );
                return;
              }
              finishOne(res, results.rows[0]);
            }
          );
        } else {
          finishOne(res, results.rows[0]);
        }
      }
    );
  }

  isConversationOwner(zid, uid, doneChecking);
}

function handle_GET_metadata_choices(req: { p: { zid: number } }, res: any) {
  const zid = req.p.zid;

  getChoicesForConversation(zid).then(
    function (choices: any) {
      finishArray(res, choices);
    },
    function (err: any) {
      failJson(res, 500, "polis_err_get_participant_metadata_choices", err);
    }
  );
}
function handle_GET_metadata_answers(
  req: { p: { zid: number; zinvite: string; suzinvite: any; pmqid: any } },
  res: any
) {
  const zid = req.p.zid;
  const zinvite = req.p.zinvite;
  const suzinvite = req.p.suzinvite;
  const pmqid = req.p.pmqid;

  function doneChecking(err: number | null) {
    if (err) {
      failJson(res, 403, "polis_err_get_participant_metadata_auth", err);
      return;
    }
    let query = sql_participant_metadata_answers
      .select(sql_participant_metadata_answers.star())
      .where(sql_participant_metadata_answers.zid.equals(zid))
      .and(sql_participant_metadata_answers.alive.equals(true));

    if (pmqid) {
      query = query.where(sql_participant_metadata_answers.pmqid.equals(pmqid));
    }
    pg.query_readOnly(
      query.toString(),
      function (err: any, result: { rows: any[] }) {
        if (err) {
          failJson(res, 500, "polis_err_get_participant_metadata_answers", err);
          return;
        }
        const rows = result.rows.map(function (r: { is_exclusive: boolean }) {
          r.is_exclusive = true; // TODO fetch this info from the queston itself
          return r;
        });
        finishArray(res, rows);
      }
    );
  }

  if (zinvite) {
    checkZinviteCodeValidity(zid, zinvite, doneChecking);
  } else if (suzinvite) {
    checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
  } else {
    doneChecking(null);
  }
}
function handle_GET_metadata(
  req: { p: { zid: number; zinvite: string; suzinvite: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: {
        (arg0: { kvp?: {}; keys?: {}; values?: {} }): void;
        new (): any;
      };
    };
  }
) {
  const zid = req.p.zid;
  const zinvite = req.p.zinvite;
  const suzinvite = req.p.suzinvite;

  function doneChecking(err: number | null) {
    if (err) {
      failJson(res, 403, "polis_err_get_participant_metadata_auth", err);
      return;
    }

    async.parallel(
      [
        function (callback: any) {
          pg.query_readOnly(
            "SELECT * FROM participant_metadata_questions WHERE zid = ($1);",
            [zid],
            callback
          );
        },
        function (callback: any) {
          pg.query_readOnly(
            "SELECT * FROM participant_metadata_answers WHERE zid = ($1);",
            [zid],
            callback
          );
        },
        function (callback: any) {
          pg.query_readOnly(
            "SELECT * FROM participant_metadata_choices WHERE zid = ($1);",
            [zid],
            callback
          );
        },
      ],
      function (err: any, result: { rows: any }[]) {
        if (err) {
          failJson(res, 500, "polis_err_get_participant_metadata", err);
          return;
        }
        const keys = result[0] && result[0].rows;
        const vals = result[1] && result[1].rows;
        const choices = result[2] && result[2].rows;
        const o = {};
        const keyNames = {};
        const valueNames = {};
        let i;
        let k;
        let v;
        if (!keys || !keys.length) {
          res.status(200).json({});
          return;
        }
        for (i = 0; i < keys.length; i++) {
          // Add a map for each keyId
          k = keys[i];
          o[k.pmqid] = {};
          keyNames[k.pmqid] = k.key;
        }
        for (i = 0; i < vals.length; i++) {
          // Add an array for each possible valueId
          k = vals[i];
          v = vals[i];
          o[k.pmqid][v.pmaid] = [];
          valueNames[v.pmaid] = v.value;
        }
        for (i = 0; i < choices.length; i++) {
          // Append a pid for each person who has seleted that value for that key.
          o[choices[i].pmqid][choices[i].pmaid] = choices[i].pid;
        }
        // TODO cache
        res.status(200).json({
          kvp: o, // key_id => value_id => [pid]
          keys: keyNames,
          values: valueNames,
        });
      }
    );
  }

  if (zinvite) {
    checkZinviteCodeValidity(zid, zinvite, doneChecking);
  } else if (suzinvite) {
    checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
  } else {
    doneChecking(null);
  }
}

function getConversationHasMetadata(zid: number) {
  return new Promise(function (
    resolve: (arg0: boolean) => void,
    reject: (arg0: string) => any
  ) {
    pg.query_readOnly(
      "SELECT * from participant_metadata_questions where zid = ($1)",
      [zid],
      function (err: any, metadataResults: { rows: string | any[] }) {
        if (err) {
          return reject("polis_err_get_conversation_metadata_by_zid");
        }
        const hasNoMetadata =
          !metadataResults ||
          !metadataResults.rows ||
          !metadataResults.rows.length;
        resolve(!hasNoMetadata);
      }
    );
  });
}

export {
  getConversationHasMetadata,
  handle_DELETE_metadata_answers,
  handle_DELETE_metadata_questions,
  handle_GET_metadata_answers,
  handle_GET_metadata_choices,
  handle_GET_metadata_questions,
  handle_GET_metadata,
  handle_POST_metadata_answers,
  handle_POST_metadata_questions,
};
