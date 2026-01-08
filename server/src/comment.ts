import _ from "underscore";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Translate } = require("@google-cloud/translate").v2;

import { GetCommentsParams, ConversationInfo } from "./d";
import { getConversationInfo } from "./conversation";
import { MPromise } from "./utils/metered";
import Config from "./config";
import pg from "./db/pg-query";
import SQL from "./db/sql";
import Utils from "./utils/common";
import { isProConvo } from "./routes/comments";
import { UUID } from "crypto";

export type CommentRow = {
  tid: number;
  disagree_count: number;
  agree_count: number;
  vote: any;
  count: number;
  pass_count: number;
  // Additional properties that are used in the code
  txt?: string;
  created?: any;
  uid?: number;
  quote_src_url?: string;
  is_seed?: boolean;
  is_meta?: boolean;
  lang?: string;
  pid?: number;
  velocity?: number;
  zid?: number;
  mod?: number;
  active?: boolean;
  randomN?: number;
  original_id?: UUID;
};

export type CommentTranslationRow = {
  zid: number;
  tid: number;
  txt: string;
  lang: string;
  src: number;
  modified?: any;
};

type Docs = {
  rows: CommentRow[];
};

const useTranslateApi: boolean = Config.shouldUseTranslationAPI;
const translateClient = useTranslateApi ? new Translate() : null;

function getComment(zid: number, tid: number): Promise<CommentRow | null> {
  return pg
    .queryP("select * from comments where zid = ($1) and tid = ($2);", [
      zid,
      tid,
    ])
    .then((rows: CommentRow[]) => {
      return (rows && rows[0]) || null;
    });
}

function getCommentsCount(o: GetCommentsParams): Promise<number> {
  return getConversationInfo(o.zid).then(function (conv: ConversationInfo) {
    let query = "";
    const params: any[] = [o.zid];

    if (o.moderation) {
      // Count query for moderation list
      let modClause = "";
      if (!_.isUndefined(o.mod)) {
        modClause = " and comments.mod = ($2)";
        params.push(o.mod);
      } else if (!_.isUndefined(o.mod_gt)) {
        modClause = " and comments.mod > ($2)";
        params.push(o.mod_gt);
      } else if (!_.isUndefined(o.modIn)) {
        if (o.modIn === true) {
          if (conv.strict_moderation) {
            modClause = " and comments.mod > 0";
          } else {
            modClause = " and comments.mod >= 0";
          }
        } else if (o.modIn === false) {
          if (conv.strict_moderation) {
            modClause = " and comments.mod <= 0";
          } else {
            modClause = " and comments.mod < 0";
          }
        }
      }
      query =
        "select count(*) from comments where comments.zid = ($1)" + modClause;
    } else {
      // Count query for regular list
      let conditions = "zid = ($1) AND active = true AND velocity > 0";
      let paramIndex = 2;

      if (!_.isUndefined(o.tids)) {
        conditions += ` AND tid = ANY($${paramIndex}::int[])`;
        params.push(o.tids);
        paramIndex++;
      }

      if (!_.isUndefined(o.mod)) {
        conditions += ` AND mod = ($${paramIndex})`;
        params.push(o.mod);
        paramIndex++;
      }

      if (conv.strict_moderation) {
        conditions += ` AND mod = ${Utils.polisTypes.mod.ok}`;
      } else {
        conditions += ` AND mod != ${Utils.polisTypes.mod.ban}`;
      }

      if (!_.isUndefined(o.not_voted_by_pid)) {
        query = `
          SELECT count(*) FROM comments 
          WHERE ${conditions} 
          AND tid NOT IN (
            SELECT tid FROM votes_latest_unique 
            WHERE zid = ($1) AND pid = ($${paramIndex})
          )
        `;
        params.push(o.not_voted_by_pid);
        paramIndex++;
      } else {
        query = `SELECT count(*) FROM comments WHERE ${conditions}`;
      }

      if (!_.isUndefined(o.withoutTids) && o.withoutTids.length > 0) {
        query = query.replace(
          "WHERE",
          `WHERE tid != ALL($${paramIndex}::int[]) AND`
        );
        params.push(o.withoutTids);
      }
    }

    return pg.queryP_readOnly(query, params).then((rows: any[]) => {
      const count = rows[0]?.count || 0;
      return Number(count);
    });
  });
}

function getComments(o: GetCommentsParams): Promise<CommentRow[]> {
  const commentListPromise = o.moderation
    ? _getCommentsForModerationList(o as any)
    : _getCommentsList(o as any);
  const convPromise = getConversationInfo(o.zid);
  return Promise.all([convPromise, commentListPromise])
    .then(function (a: [any, CommentRow[]]) {
      let rows: CommentRow[] = a[1];
      const cols = [
        "txt",
        "tid",
        "created",
        "uid",
        "quote_src_url",
        "is_seed",
        "is_meta",
        "lang",
        "pid",
        "original_id",
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
      rows = rows.map(function (row: CommentRow): CommentRow {
        const x = _.pick(row, cols) as CommentRow;
        if (!_.isUndefined(x.count)) {
          x.count = Number(x.count);
        }
        return x;
      });
      return rows;
    })
    .then(function (comments: CommentRow[]): CommentRow[] {
      comments.forEach(function (c: { uid?: any }) {
        delete c.uid;
      });
      return comments;
    });
}

function _getCommentsForModerationList(o: {
  include_voting_patterns: any;
  modIn: boolean;
  zid: number;
  strict_moderation: any;
  mod: any;
  mod_gt: any;
  limit?: any;
  offset?: any;
}): Promise<CommentRow[]> {
  let strictCheck: Promise<any> = Promise.resolve(null);
  const include_voting_patterns = o.include_voting_patterns;
  let isProOwner = false;

  if (o.modIn) {
    strictCheck = pg
      .queryP("select strict_moderation from conversations where zid = ($1);", [
        o.zid,
      ])
      .then(() => {
        return o.strict_moderation;
      });
  }

  return pg
    .queryP("select owner from conversations where zid = ($1);", [o.zid])
    .then(async (z: { owner: number }[]) => {
      isProOwner =
        o.mod_gt && Number(o.mod_gt) > -2
          ? await isProConvo(z[0].owner)
          : false;
    })
    .then(() =>
      strictCheck.then((strict_moderation): Promise<CommentRow[]> => {
        let modClause = "";
        const params = [o.zid];
        if (!_.isUndefined(o.mod)) {
          modClause = " and comments.mod = ($2)";
          params.push(o.mod);
        } else if (isProOwner) {
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
          let query =
            "select * from comments where comments.zid = ($1)" + modClause;

          // Add pagination if provided
          if (!_.isUndefined(o.limit)) {
            const limitParam = params.length + 1;
            const offsetParam = params.length + 2;
            query += ` LIMIT ($${limitParam}) OFFSET ($${offsetParam})`;
            params.push(o.limit);
            params.push(o.offset || 0);
          }

          return pg.queryP_metered_readOnly(
            "_getCommentsForModerationList",
            query,
            params
          ) as Promise<CommentRow[]>;
        }

        let votingQuery =
          "select * from (select tid, vote, count(*) from votes_latest_unique where zid = ($1) group by tid, vote) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1)" +
          modClause;

        // Add pagination if provided
        if (!_.isUndefined(o.limit)) {
          const limitParam = params.length + 1;
          const offsetParam = params.length + 2;
          votingQuery += ` LIMIT ($${limitParam}) OFFSET ($${offsetParam})`;
          params.push(o.limit);
          params.push(o.offset || 0);
        }

        return pg
          .queryP_metered_readOnly(
            "_getCommentsForModerationList",
            votingQuery,
            params
          )
          .then((rows: CommentRow[]) => {
            // each comment will have up to three rows. merge those into one with agree/disagree/pass counts.
            const adp: { [key: string]: CommentRow } = {};
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              const o = (adp[row.tid] = adp[row.tid] || {
                tid: row.tid,
                vote: 0,
                count: 0,
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
            rows = _.uniq(rows, false, (row: { tid: number }) => {
              return row.tid;
            });

            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              row.agree_count = adp[row.tid].agree_count;
              row.disagree_count = adp[row.tid].disagree_count;
              row.pass_count = adp[row.tid].pass_count;
              row.count = row.agree_count + row.disagree_count + row.pass_count;
            }
            return rows;
          });
      })
    );
}

function _getCommentsList(o: {
  zid: number;
  pid: number;
  tids: any;
  mod: any;
  not_voted_by_pid: number;
  withoutTids: any;
  moderation: any;
  random: any;
  limit: any;
  offset?: any;
}): Promise<CommentRow[]> {
  return MPromise(
    "_getCommentsList",
    function (
      resolve: (rows: CommentRow[]) => void,
      reject: (arg0: any) => void
    ) {
      getConversationInfo(o.zid).then(function (conv: ConversationInfo) {
        let q = SQL.sql_comments
          .select(SQL.sql_comments.star())
          .where(SQL.sql_comments.zid.equals(o.zid));
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
          q = q.limit(999); // Default limit for backward compatibility
        }
        if (!_.isUndefined(o.offset)) {
          q = q.offset(o.offset);
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
  ) as Promise<CommentRow[]>;
}

function getNumberOfCommentsRemaining(zid: number, pid: number): Promise<any> {
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

function translateAndStoreComment(
  zid: number,
  tid: number,
  txt: any,
  lang: string
): Promise<CommentTranslationRow | null> {
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
        .then((rows: CommentTranslationRow[]) => {
          return rows[0];
        });
    });
  }
  return Promise.resolve(null);
}

function translateString(txt: any, target_lang: any): Promise<any[] | null> {
  if (useTranslateApi) {
    return translateClient.translate(txt, target_lang);
  }
  return Promise.resolve(null);
}

function detectLanguage(
  txt: any
): Promise<Array<{ confidence: any; language: any }>> {
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
  detectLanguage,
  getComment,
  getComments,
  getCommentsCount,
  getNumberOfCommentsRemaining,
  translateAndStoreComment,
};

// types already exported above via `export type`
