import _ from "underscore";
const { Translate } = require("@google-cloud/translate").v2;

import pg from "./db/pg-query";
import SQL from "./db/sql";
import { MPromise } from "./utils/metered";
import Utils from "./utils/common";

import Config from "./config";
import Conversation from "./conversation";
import { CommentType } from "./d";

// TODO should this be a number instead?
type Id = string;

type Row = {
  tid: Id;
  disagree_count: number;
  agree_count: number;
  vote: any;
  count: number;
  pass_count: number;
};

type Docs = {
  rows: Row[];
};

const useTranslateApi: boolean = Config.shouldUseTranslationAPI;
const translateClient = useTranslateApi ? new Translate() : null;

function getComment(zid: Id, tid: Id) {
  return (
    pg
      .queryP("select * from comments where zid = ($1) and tid = ($2);", [
        zid,
        tid,
      ])

      // Argument of type '(rows: Row[]) => Row' is not assignable to parameter of type '(value: unknown) => Row | PromiseLike<Row>'.
      // Types of parameters 'rows' and 'value' are incompatible.
      // Type 'unknown' is not assignable to type 'Row[]'.ts(2345)
      // @ts-ignore
      .then((rows: Row[]) => {
        return (rows && rows[0]) || null;
      })
  );
}

function getComments(o: CommentType) {
  let commentListPromise = o.moderation
    ? _getCommentsForModerationList(o)
    : _getCommentsList(o);
  let convPromise = Conversation.getConversationInfo(o.zid);
  return Promise.all([convPromise, commentListPromise])
    .then(function (a) {
      let rows = a[1];
      let cols = [
        "txt",
        "tid",
        "created",
        "uid",
        "quote_src_url",
        "anon",
        "is_seed",
        "is_meta",
        "lang",
        "pid",
      ];
      if (o.moderation) {
        cols.push("velocity");
        cols.push("zid");
        cols.push("mod");
        cols.push("active");
        cols.push("agree_count"); //  in  moderation queries, we join in the vote count
        cols.push("disagree_count"); //  in  moderation queries, we join in the vote count
        cols.push("pass_count"); //  in  moderation queries, we join in the vote count
        cols.push("count"); //  in  moderation queries, we join in the vote count
      }
      rows = rows.map(function (row: Row) {
        let x = _.pick(row, cols);
        if (!_.isUndefined(x.count)) {
          x.count = Number(x.count);
        }
        return x;
      });
      return rows;
    })
    .then(function (comments) {
      comments.forEach(function (c: { uid: any; anon: any }) {
        delete c.uid;
        delete c.anon;
      });
      return comments;
    });
}

function _getCommentsForModerationList(o: {
  include_voting_patterns: any;
  modIn: boolean;
  zid: any;
  strict_moderation: any;
  mod: any;
  mod_gt: any;
}) {
  var strictCheck = Promise.resolve(null);
  var include_voting_patterns = o.include_voting_patterns;

  if (o.modIn) {
    strictCheck = pg
      .queryP("select strict_moderation from conversations where zid = ($1);", [
        o.zid,
      ])
      .then(() => {
        return o.strict_moderation;
      });
  }

  return strictCheck.then((strict_moderation) => {
    let modClause = "";
    let params = [o.zid];
    if (!_.isUndefined(o.mod)) {
      modClause = " and comments.mod = ($2)";
      params.push(o.mod);
    } else if (!_.isUndefined(o.mod_gt)) {
      modClause = " and comments.mod > ($2)";
      params.push(o.mod_gt);
    } else if (!_.isUndefined(o.modIn)) {
      if (o.modIn === true) {
        if (strict_moderation) {
          modClause = " and comments.mod > 0";
        } else {
          modClause = " and comments.mod >= 0";
        }
      } else if (o.modIn === false) {
        if (strict_moderation) {
          modClause = " and comments.mod <= 0";
        } else {
          modClause = " and comments.mod < 0";
        }
      }
    }
    if (!include_voting_patterns) {
      return pg.queryP_metered_readOnly(
        "_getCommentsForModerationList",
        "select * from comments where comments.zid = ($1)" + modClause,
        params
      );
    }

    return pg
      .queryP_metered_readOnly(
        "_getCommentsForModerationList",
        "select * from (select tid, vote, count(*) from votes_latest_unique where zid = ($1) group by tid, vote) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1)" +
        modClause,
        params
      )
      .then((rows: Row[]) => {
        // each comment will have up to three rows. merge those into one with agree/disagree/pass counts.
        let adp: { [key: string]: Row } = {};
        for (let i = 0; i < rows.length; i++) {
          let row = rows[i];
          let o = (adp[row.tid] = adp[row.tid] || {
            agree_count: 0,
            disagree_count: 0,
            pass_count: 0,
          });
          if (row.vote === Utils.polisTypes.reactions.pull) {
            o.agree_count = Number(row.count);
          } else if (row.vote === Utils.polisTypes.reactions.push) {
            o.disagree_count = Number(row.count);
          } else if (row.vote === Utils.polisTypes.reactions.pass) {
            o.pass_count = Number(row.count);
          }
        }
        rows = _.uniq(rows, false, (row: { tid: Id }) => {
          return row.tid;
        });

        for (let i = 0; i < rows.length; i++) {
          let row = rows[i];
          row.agree_count = adp[row.tid].agree_count;
          row.disagree_count = adp[row.tid].disagree_count;
          row.pass_count = adp[row.tid].pass_count;
          row.count = row.agree_count + row.disagree_count + row.pass_count;
        }
        return rows;
      });
  });
}

function _getCommentsList(o: {
  zid: any;
  pid: any;
  tids: any;
  mod: any;
  not_voted_by_pid: any;
  withoutTids: any;
  moderation: any;
  random: any;
  limit: any;
}) {
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.ts(7009)
  // @ts-ignore
  return new MPromise(
    "_getCommentsList",
    function (resolve: (rows: Row[]) => void, reject: (arg0: any) => void) {
      Conversation.getConversationInfo(o.zid).then(function (conv: {
        strict_moderation: any;
        prioritize_seed: any;
      }) {
        let q = SQL.sql_comments
          .select(SQL.sql_comments.star())
          .where(SQL.sql_comments.zid.equals(o.zid));
        if (!_.isUndefined(o.pid)) {
          q = q.and(SQL.sql_comments.pid.equals(o.pid));
        }
        if (!_.isUndefined(o.tids)) {
          q = q.and(SQL.sql_comments.tid.in(o.tids));
        }
        if (!_.isUndefined(o.mod)) {
          q = q.and(SQL.sql_comments.mod.equals(o.mod));
        }
        if (!_.isUndefined(o.not_voted_by_pid)) {
          // 'SELECT * FROM comments WHERE zid = 12 AND tid NOT IN (SELECT tid FROM votes WHERE pid = 1);'
          // Don't return comments the user has already voted on.
          q = q.and(
            SQL.sql_comments.tid.notIn(
              SQL.sql_votes_latest_unique
                .subQuery()
                .select(SQL.sql_votes_latest_unique.tid)
                .where(SQL.sql_votes_latest_unique.zid.equals(o.zid))
                .and(SQL.sql_votes_latest_unique.pid.equals(o.not_voted_by_pid))
            )
          );
        }

        if (!_.isUndefined(o.withoutTids)) {
          q = q.and(SQL.sql_comments.tid.notIn(o.withoutTids));
        }
        q = q.and(SQL.sql_comments.active.equals(true));
        if (conv.strict_moderation) {
          q = q.and(SQL.sql_comments.mod.equals(Utils.polisTypes.mod.ok));
        } else {
          q = q.and(SQL.sql_comments.mod.notEquals(Utils.polisTypes.mod.ban));
        }

        q = q.and(SQL.sql_comments.velocity.gt(0)); // filter muted comments

        if (!_.isUndefined(o.random)) {
          if (conv.prioritize_seed) {
            q = q.order("is_seed desc, random()");
          } else {
            q = q.order("random()");
          }
        } else {
          q = q.order(SQL.sql_comments.created);
        }
        if (!_.isUndefined(o.limit)) {
          q = q.limit(o.limit);
        } else {
          q = q.limit(999); // TODO paginate
        }
        return pg.query(q.toString(), [], function (err: any, docs: Docs) {
          if (err) {
            reject(err);
            return;
          }
          if (docs.rows && docs.rows.length) {
            resolve(docs.rows);
          } else {
            resolve([]);
          }
        });
      });
    }
  );
}

function getNumberOfCommentsRemaining(zid: any, pid: any) {
  return pg.queryP(
    "with " +
    "v as (select * from votes_latest_unique where zid = ($1) and pid = ($2)), " +
    "c as (select * from get_visible_comments($1)), " +
    "remaining as (select count(*) as remaining from c left join v on c.tid = v.tid where v.vote is null), " +
    "total as (select count(*) as total from c) " +
    "select cast(remaining.remaining as integer), cast(total.total as integer), cast(($2) as integer) as pid from remaining, total;",
    [zid, pid]
  );
}

function translateAndStoreComment(zid: any, tid: any, txt: any, lang: any) {
  if (useTranslateApi) {
    return translateString(txt, lang).then((results: any[]) => {
      const translation = results[0];
      const src = -1; // Google Translate of txt with no added context
      return pg
        .queryP(
          "insert into comment_translations (zid, tid, txt, lang, src) values ($1, $2, $3, $4, $5) " +
          "on conflict (zid, tid, src, lang) do update set " +
          "txt = excluded.txt, " +
          "modified = now_as_millis() " +
          "returning *;",
          [zid, tid, translation, lang, src]
        )
        // @ts-ignore
        .then((rows: Row[]) => {
          return rows[0];
        });
    });
  }
  return Promise.resolve(null);
}

function translateString(txt: any, target_lang: any) {
  if (useTranslateApi) {
    return translateClient.translate(txt, target_lang);
  }
  return Promise.resolve(null);
}

function detectLanguage(txt: any) {
  if (useTranslateApi) {
    return translateClient.detect(txt);
  }
  return Promise.resolve([
    {
      confidence: null,
      language: null,
    },
  ]);
}

export {
  getComment,
  getComments,
  _getCommentsForModerationList,
  _getCommentsList,
  getNumberOfCommentsRemaining,
  translateAndStoreComment,
  detectLanguage,
};

export default {
  getComment,
  getComments,
  _getCommentsForModerationList,
  _getCommentsList,
  getNumberOfCommentsRemaining,
  translateAndStoreComment,
  detectLanguage,
};
