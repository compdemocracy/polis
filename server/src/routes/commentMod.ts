import { failJson } from "../utils/fail";
import { getNextComment } from "../nextComment";
import { isDuplicateKey } from "../utils/common";
import { ParticipantCommentModerationResult } from "../d";
import pg from "../db/pg-query";
import {
  addNoMoreCommentsRecord,
  addStar,
  finishOne,
  safeTimestampToMillis,
  updateConversationModifiedTime,
  updateLastInteractionTimeForConversation,
} from "../server-helpers";

function handle_POST_ptptCommentMod(
  req: {
    p: {
      zid: number;
      pid: number;
      uid?: number;
      tid: number;
      as_abusive: any;
      as_factual: any;
      as_feeling: any;
      as_important: any;
      as_notfact: any;
      as_notgoodidea: any;
      as_notmyfeeling: any;
      as_offtopic: any;
      as_spam: any;
      unsure: any;
      lang: string;
    };
  },
  res: any
) {
  const zid = req.p.zid;
  const pid = req.p.pid;
  const uid = req.p.uid;

  return pg
    .queryP(
      "insert into crowd_mod (" +
        "zid, " +
        "pid, " +
        "tid, " +
        "as_abusive, " +
        "as_factual, " +
        "as_feeling, " +
        "as_important, " +
        "as_notfact, " +
        "as_notgoodidea, " +
        "as_notmyfeeling, " +
        "as_offtopic, " +
        "as_spam, " +
        "as_unsure) values (" +
        "$1, " +
        "$2, " +
        "$3, " +
        "$4, " +
        "$5, " +
        "$6, " +
        "$7, " +
        "$8, " +
        "$9, " +
        "$10, " +
        "$11, " +
        "$12, " +
        "$13);",
      [
        req.p.zid,
        req.p.pid,
        req.p.tid,
        req.p.as_abusive,
        req.p.as_factual,
        req.p.as_feeling,
        req.p.as_important,
        req.p.as_notfact,
        req.p.as_notgoodidea,
        req.p.as_notmyfeeling,
        req.p.as_offtopic,
        req.p.as_spam,
        req.p.unsure,
      ]
    )
    .then((createdTime: any) => {
      setTimeout(function () {
        updateConversationModifiedTime(req.p.zid, createdTime);
        updateLastInteractionTimeForConversation(zid, uid);
      }, 100);
    })
    .then(function () {
      return getNextComment(req.p.zid, pid, [], req.p.lang);
    })
    .then(function (nextComment: any) {
      const result: ParticipantCommentModerationResult = {};
      if (nextComment) {
        result.nextComment = nextComment;
      } else {
        // no need to wait for this to finish
        addNoMoreCommentsRecord(req.p.zid, pid);
      }
      // PID_FLOW This may be the first time the client gets the pid.
      result.currentPid = req.p.pid;
      finishOne(res, result);
    })
    .catch(function (err: string) {
      if (err === "polis_err_ptptCommentMod_duplicate") {
        failJson(res, 406, "polis_err_ptptCommentMod_duplicate", err); // TODO allow for changing votes?
      } else if (err === "polis_err_conversation_is_closed") {
        failJson(res, 403, "polis_err_conversation_is_closed", err);
      } else {
        failJson(res, 500, "polis_err_ptptCommentMod", err);
      }
    });
}

function handle_POST_upvotes(
  req: { p: { uid?: number; zid: number } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;

  pg.queryP("select * from upvotes where uid = ($1) and zid = ($2);", [
    uid,
    zid,
  ]).then(
    function (rows: string | any[]) {
      if (rows && rows.length) {
        failJson(res, 403, "polis_err_upvote_already_upvoted");
      } else {
        pg.queryP("insert into upvotes (uid, zid) VALUES ($1, $2);", [
          uid,
          zid,
        ]).then(
          function () {
            pg.queryP(
              "update conversations set upvotes = (select count(*) from upvotes where zid = ($1)) where zid = ($1);",
              [zid]
            ).then(
              function () {
                res.status(200).json({});
              },
              function (err: any) {
                failJson(res, 500, "polis_err_upvote_update", err);
              }
            );
          },
          function (err: any) {
            failJson(res, 500, "polis_err_upvote_insert", err);
          }
        );
      }
    },
    function (err: any) {
      failJson(res, 500, "polis_err_upvote_check", err);
    }
  );
}

function handle_POST_stars(
  req: { p: { zid: number; tid: number; pid: number; starred: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  addStar(req.p.zid, req.p.tid, req.p.pid, req.p.starred)
    .then(function (result: { rows: { created: any }[] }) {
      const createdTimeMillis = safeTimestampToMillis(result.rows[0].created);
      setTimeout(function () {
        updateConversationModifiedTime(req.p.zid, createdTimeMillis);
      }, 100);
      res.status(200).json({}); // TODO don't stop after the first one, map the inserts to deferreds.
    })
    .catch(function (err: any) {
      if (err) {
        if (isDuplicateKey(err)) {
          failJson(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
        } else {
          failJson(res, 500, "polis_err_vote", err);
        }
      }
    });
}

function handle_POST_trashes(
  req: { p: { pid: number; zid: number; tid: number; trashed: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  const query =
    "INSERT INTO trashes (pid, zid, tid, trashed, created) VALUES ($1, $2, $3, $4, default);";
  const params = [req.p.pid, req.p.zid, req.p.tid, req.p.trashed];
  pg.query(
    query,
    params,
    function (err: any, result: { rows: { created: any }[] }) {
      if (err) {
        if (isDuplicateKey(err)) {
          failJson(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
        } else {
          failJson(res, 500, "polis_err_vote", err);
        }
        return;
      }

      const createdTimeMillis = safeTimestampToMillis(result.rows[0].created);
      setTimeout(function () {
        updateConversationModifiedTime(req.p.zid, createdTimeMillis);
      }, 100);

      res.status(200).json({}); // TODO don't stop after the first one, map the inserts to deferreds.
    }
  );
}

export {
  handle_POST_ptptCommentMod,
  handle_POST_upvotes,
  handle_POST_stars,
  handle_POST_trashes,
};
