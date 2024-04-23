import _ from 'underscore';
import Translate from '@google-cloud/translate';
import pg from './db/pg-query.js';
import SQL from './db/sql.js';
import { MPromise } from './utils/metered.js';
import Utils from './utils/common.js';
import logger from './utils/logger.js';
import Config from './config.js';
import Conversation from './conversation.js';
import User from './user.js';
const useTranslateApi = Config.shouldUseTranslationAPI;
const translateClient = useTranslateApi ? Translate() : null;
function getComment(zid, tid) {
  return pg.queryP('select * from comments where zid = ($1) and tid = ($2);', [zid, tid]).then((rows) => {
    return (rows && rows[0]) || null;
  });
}
function getComments(o) {
  let commentListPromise = o.moderation ? _getCommentsForModerationList(o) : _getCommentsList(o);
  let convPromise = Conversation.getConversationInfo(o.zid);
  let conv = null;
  return Promise.all([convPromise, commentListPromise])
    .then(function (a) {
      let rows = a[1];
      conv = a[0];
      let cols = [
        'txt',
        'tid',
        'created',
        'uid',
        'tweet_id',
        'quote_src_url',
        'anon',
        'is_seed',
        'is_meta',
        'lang',
        'pid'
      ];
      if (o.moderation) {
        cols.push('velocity');
        cols.push('zid');
        cols.push('mod');
        cols.push('active');
        cols.push('agree_count');
        cols.push('disagree_count');
        cols.push('pass_count');
        cols.push('count');
      }
      rows = rows.map(function (row) {
        let x = _.pick(row, cols);
        if (!_.isUndefined(x.count)) {
          x.count = Number(x.count);
        }
        return x;
      });
      return rows;
    })
    .then(function (comments) {
      let include_social = !conv?.is_anon && o.include_social;
      if (include_social) {
        let nonAnonComments = comments.filter(function (c) {
          return !c.anon && !c.is_seed;
        });
        let uids = _.pluck(nonAnonComments, 'uid');
        return User.getSocialInfoForUsers(uids, o.zid).then(function (socialInfos) {
          let uidToSocialInfo = {};
          socialInfos.forEach(function (info) {
            let infoToReturn = _.pick(info, [
              'fb_name',
              'fb_link',
              'fb_user_id',
              'name',
              'screen_name',
              'twitter_user_id',
              'profile_image_url_https',
              'followers_count',
              'x_profile_image_url',
              'x_name'
            ]);
            infoToReturn.tw_verified = !!info.verified;
            infoToReturn.tw_followers_count = info.followers_count;
            if (info.fb_public_profile) {
              try {
                let temp = JSON.parse(info.fb_public_profile);
                infoToReturn.fb_verified = temp.verified;
              } catch (err) {
                logger.error('error parsing JSON of fb_public_profile for uid: ' + info.uid, err);
              }
            }
            if (!_.isUndefined(infoToReturn.fb_user_id)) {
              let width = 40;
              let height = 40;
              infoToReturn.fb_picture = `https://graph.facebook.com/v2.2/${infoToReturn.fb_user_id}/picture?width=${width}&height=${height}`;
            }
            uidToSocialInfo[info.uid] = infoToReturn;
          });
          return comments.map(function (c) {
            let s = uidToSocialInfo[c.uid];
            if (s) {
              if (!c.anon) {
                c.social = s;
              }
            }
            return c;
          });
        });
      } else {
        return comments;
      }
    })
    .then(function (comments) {
      comments.forEach(function (c) {
        delete c.uid;
        delete c.anon;
      });
      return comments;
    });
}
function _getCommentsForModerationList(o) {
  var strictCheck = Promise.resolve(null);
  var include_voting_patterns = o.include_voting_patterns;
  if (o.modIn) {
    strictCheck = pg.queryP('select strict_moderation from conversations where zid = ($1);', [o.zid]).then((c) => {
      return o.strict_moderation;
    });
  }
  return strictCheck.then((strict_moderation) => {
    let modClause = '';
    let params = [o.zid];
    if (!_.isUndefined(o.mod)) {
      modClause = ' and comments.mod = ($2)';
      params.push(o.mod);
    } else if (!_.isUndefined(o.mod_gt)) {
      modClause = ' and comments.mod > ($2)';
      params.push(o.mod_gt);
    } else if (!_.isUndefined(o.modIn)) {
      if (o.modIn === true) {
        if (strict_moderation) {
          modClause = ' and comments.mod > 0';
        } else {
          modClause = ' and comments.mod >= 0';
        }
      } else if (o.modIn === false) {
        if (strict_moderation) {
          modClause = ' and comments.mod <= 0';
        } else {
          modClause = ' and comments.mod < 0';
        }
      }
    }
    if (!include_voting_patterns) {
      return pg.queryP_metered_readOnly(
        '_getCommentsForModerationList',
        'select * from comments where comments.zid = ($1)' + modClause,
        params
      );
    }
    return pg
      .queryP_metered_readOnly(
        '_getCommentsForModerationList',
        'select * from (select tid, vote, count(*) from votes_latest_unique where zid = ($1) group by tid, vote) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1)' +
          modClause,
        params
      )
      .then((rows) => {
        let adp = {};
        for (let i = 0; i < rows.length; i++) {
          let row = rows[i];
          let o = (adp[row.tid] = adp[row.tid] || {
            agree_count: 0,
            disagree_count: 0,
            pass_count: 0
          });
          if (row.vote === Utils.polisTypes.reactions.pull) {
            o.agree_count = Number(row.count);
          } else if (row.vote === Utils.polisTypes.reactions.push) {
            o.disagree_count = Number(row.count);
          } else if (row.vote === Utils.polisTypes.reactions.pass) {
            o.pass_count = Number(row.count);
          }
        }
        rows = _.uniq(rows, false, (row) => {
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
function _getCommentsList(o) {
  return new MPromise('_getCommentsList', function (resolve, reject) {
    Conversation.getConversationInfo(o.zid).then(function (conv) {
      let q = SQL.sql_comments.select(SQL.sql_comments.star()).where(SQL.sql_comments.zid.equals(o.zid));
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
      if (o.moderation) {
      } else {
        q = q.and(SQL.sql_comments.active.equals(true));
        if (conv.strict_moderation) {
          q = q.and(SQL.sql_comments.mod.equals(Utils.polisTypes.mod.ok));
        } else {
          q = q.and(SQL.sql_comments.mod.notEquals(Utils.polisTypes.mod.ban));
        }
      }
      q = q.and(SQL.sql_comments.velocity.gt(0));
      if (!_.isUndefined(o.random)) {
        if (conv.prioritize_seed) {
          q = q.order('is_seed desc, random()');
        } else {
          q = q.order('random()');
        }
      } else {
        q = q.order(SQL.sql_comments.created);
      }
      if (!_.isUndefined(o.limit)) {
        q = q.limit(o.limit);
      } else {
        q = q.limit(999);
      }
      return pg.query(q.toString(), [], function (err, docs) {
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
  });
}
function getNumberOfCommentsRemaining(zid, pid) {
  return pg.queryP(
    'with ' +
      'v as (select * from votes_latest_unique where zid = ($1) and pid = ($2)), ' +
      'c as (select * from get_visible_comments($1)), ' +
      'remaining as (select count(*) as remaining from c left join v on c.tid = v.tid where v.vote is null), ' +
      'total as (select count(*) as total from c) ' +
      'select cast(remaining.remaining as integer), cast(total.total as integer), cast(($2) as integer) as pid from remaining, total;',
    [zid, pid]
  );
}
function translateAndStoreComment(zid, tid, txt, lang) {
  if (useTranslateApi) {
    return translateString(txt, lang).then((results) => {
      const translation = results[0];
      const src = -1;
      return pg
        .queryP(
          'insert into comment_translations (zid, tid, txt, lang, src) values ($1, $2, $3, $4, $5) returning *;',
          [zid, tid, translation, lang, src]
        )
        .then((rows) => {
          return rows[0];
        });
    });
  }
  return Promise.resolve(null);
}
function translateString(txt, target_lang) {
  if (useTranslateApi) {
    return translateClient.translate(txt, target_lang);
  }
  return Promise.resolve(null);
}
function detectLanguage(txt) {
  if (useTranslateApi) {
    return translateClient.detect(txt);
  }
  return Promise.resolve([
    {
      confidence: null,
      language: null
    }
  ]);
}
export {
  getComment,
  getComments,
  _getCommentsForModerationList,
  _getCommentsList,
  getNumberOfCommentsRemaining,
  translateAndStoreComment,
  detectLanguage
};
export default {
  getComment,
  getComments,
  _getCommentsForModerationList,
  _getCommentsList,
  getNumberOfCommentsRemaining,
  translateAndStoreComment,
  detectLanguage
};
