import _ from 'underscore';
import LruCache from 'lru-cache';
import pg from './db/pg-query.js';
import { MPromise } from './utils/metered.js';
import Conversation from './conversation.js';
import logger from './utils/logger.js';
function getUserInfoForUid(uid, callback) {
  pg.query_readOnly('SELECT email, hname from users where uid = $1', [uid], function (err, results) {
    if (err) {
      return callback(err);
    }
    if (!results.rows || !results.rows.length) {
      return callback(null);
    }
    callback(null, results.rows[0]);
  });
}
function getUserInfoForUid2(uid) {
  return new MPromise('getUserInfoForUid2', function (resolve, reject) {
    pg.query_readOnly('SELECT * from users where uid = $1', [uid], function (err, results) {
      if (err) {
        return reject(err);
      }
      if (!results.rows || !results.rows.length) {
        return reject(null);
      }
      let o = results.rows[0];
      resolve(o);
    });
  });
}
async function getUser(uid, zid_optional, xid_optional, owner_uid_optional) {
  if (!uid) {
    return Promise.resolve({});
  }
  let xidInfoPromise = Promise.resolve(null);
  if (zid_optional && xid_optional) {
    xidInfoPromise = Conversation.getXidRecord(xid_optional, zid_optional);
  } else if (xid_optional && owner_uid_optional) {
    xidInfoPromise = Conversation.getXidRecordByXidOwnerId(xid_optional, owner_uid_optional, zid_optional);
  }
  const o = await Promise.all([getUserInfoForUid2(uid), getFacebookInfo([uid]), getTwitterInfo([uid]), xidInfoPromise]);
  let info = o[0];
  let fbInfo = o[1];
  let twInfo = o[2];
  let xInfo = o[3];
  let hasFacebook = fbInfo && fbInfo.length && fbInfo[0];
  let hasTwitter = twInfo && twInfo.length && twInfo[0];
  let hasXid = xInfo && xInfo.length && xInfo[0];
  if (hasFacebook) {
    let width = 40;
    let height = 40;
    fbInfo.fb_picture =
      'https://graph.facebook.com/v2.2/' + fbInfo.fb_user_id + '/picture?width=' + width + '&height=' + height;
    delete fbInfo[0].response;
  }
  if (hasTwitter) {
    delete twInfo[0].response;
  }
  if (hasXid) {
    delete xInfo[0].owner;
    delete xInfo[0].created;
    delete xInfo[0].uid;
  }
  return {
    uid: uid,
    email: info.email,
    hname: info.hname,
    hasFacebook: !!hasFacebook,
    facebook: fbInfo && fbInfo[0],
    twitter: twInfo && twInfo[0],
    hasTwitter: !!hasTwitter,
    hasXid: !!hasXid,
    xInfo: xInfo && xInfo[0],
    finishedTutorial: !!info.tut,
    site_ids: [info.site_id],
    created: Number(info.created)
  };
}
function getTwitterInfo(uids) {
  return pg.queryP_readOnly('select * from twitter_users where uid in ($1);', uids);
}
function getFacebookInfo(uids) {
  return pg.queryP_readOnly('select * from facebook_users where uid in ($1);', uids);
}
function createDummyUser() {
  return new MPromise('createDummyUser', function (resolve, reject) {
    pg.query('INSERT INTO users (created) VALUES (default) RETURNING uid;', [], function (err, results) {
      if (err || !results || !results.rows || !results.rows.length) {
        logger.error('polis_err_create_empty_user', err);
        reject(new Error('polis_err_create_empty_user'));
        return;
      }
      resolve(results.rows[0].uid);
    });
  });
}
let pidCache = new LruCache({
  max: 9000
});
function getPid(zid, uid, callback) {
  let cacheKey = zid + '_' + uid;
  let cachedPid = pidCache.get(cacheKey);
  if (!_.isUndefined(cachedPid)) {
    callback(null, cachedPid);
    return;
  }
  pg.query_readOnly('SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);', [zid, uid], function (err, docs) {
    let pid = -1;
    if (docs && docs.rows && docs.rows[0]) {
      pid = docs.rows[0].pid;
      pidCache.set(cacheKey, pid);
    }
    callback(err, pid);
  });
}
function getPidPromise(zid, uid, usePrimary) {
  let cacheKey = zid + '_' + uid;
  let cachedPid = pidCache.get(cacheKey);
  return new MPromise('getPidPromise', function (resolve, reject) {
    if (!_.isUndefined(cachedPid)) {
      resolve(cachedPid);
      return;
    }
    const f = usePrimary ? pg.query : pg.query_readOnly;
    f('SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);', [zid, uid], function (err, results) {
      if (err) {
        return reject(err);
      }
      if (!results || !results.rows || !results.rows.length) {
        resolve(-1);
        return;
      }
      let pid = results.rows[0].pid;
      pidCache.set(cacheKey, pid);
      resolve(pid);
    });
  });
}
function getPidForParticipant(assigner, cache) {
  return function (req, res, next) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    function finish(pid) {
      assigner(req, 'pid', pid);
      next();
    }
    getPidPromise(zid, uid).then(
      function (pid) {
        if (pid === -1) {
          let msg = 'polis_err_get_pid_for_participant_missing';
          logger.error(msg, {
            zid,
            uid,
            p: req.p
          });
          next(msg);
        }
        finish(pid);
      },
      function (err) {
        logger.error('polis_err_get_pid_for_participant', err);
        next(err);
      }
    );
  };
}
function getSocialInfoForUsers(uids, zid) {
  uids = _.uniq(uids);
  uids.forEach(function (uid) {
    if (!_.isNumber(uid)) {
      throw 'polis_err_123123_invalid_uid got:' + uid;
    }
  });
  if (!uids.length) {
    return Promise.resolve([]);
  }
  let uidString = uids.join(',');
  return pg.queryP_metered_readOnly(
    'getSocialInfoForUsers',
    'with ' +
      'x as (select * from xids where uid in (' +
      uidString +
      ') and owner  in (select org_id from conversations where zid = ($1))), ' +
      'fb as (select * from facebook_users where uid in (' +
      uidString +
      ')), ' +
      'tw as (select * from twitter_users where uid in (' +
      uidString +
      ')), ' +
      'foo as (select *, coalesce(fb.uid, tw.uid) as foouid from fb full outer join tw on tw.uid = fb.uid) ' +
      'select *, coalesce(foo.foouid, x.uid) as uid from foo full outer join x on x.uid = foo.foouid;',
    [zid]
  );
}
function getXidRecordByXidOwnerId(xid, owner, zid_optional, x_profile_image_url, x_name, x_email, createIfMissing) {
  return pg.queryP('select * from xids where xid = ($1) and owner = ($2);', [xid, owner]).then(function (rows) {
    if (!rows || !rows.length) {
      logger.warn('getXidRecordByXidOwnerId: no xInfo yet');
      if (!createIfMissing) {
        return null;
      }
      var shouldCreateXidEntryPromise = !zid_optional
        ? Promise.resolve(true)
        : Conversation.getConversationInfo(zid_optional).then((conv) => {
            return conv.use_xid_whitelist ? Conversation.isXidWhitelisted(owner, xid) : Promise.resolve(true);
          });
      return shouldCreateXidEntryPromise.then((should) => {
        if (!should) {
          return null;
        }
        return createDummyUser().then((newUid) => {
          return Conversation.createXidRecord(
            owner,
            newUid,
            xid,
            x_profile_image_url || null,
            x_name || null,
            x_email || null
          ).then(() => {
            return [
              {
                uid: newUid,
                owner: owner,
                xid: xid,
                x_profile_image_url: x_profile_image_url,
                x_name: x_name,
                x_email: x_email
              }
            ];
          });
        });
      });
    }
    return rows;
  });
}
function getXidStuff(xid, zid) {
  return Conversation.getXidRecord(xid, zid).then((rows) => {
    if (!rows || !rows.length) {
      return 'noXidRecord';
    }
    let xidRecordForPtpt = rows[0];
    if (xidRecordForPtpt) {
      return getPidPromise(zid, xidRecordForPtpt.uid, true).then((pidForXid) => {
        xidRecordForPtpt.pid = pidForXid;
        return xidRecordForPtpt;
      });
    }
    return xidRecordForPtpt;
  });
}
export {
  pidCache,
  getUserInfoForUid,
  getUserInfoForUid2,
  getUser,
  createDummyUser,
  getPid,
  getPidPromise,
  getPidForParticipant,
  getSocialInfoForUsers
};
export default {
  pidCache,
  getXidRecordByXidOwnerId,
  getXidStuff,
  getUserInfoForUid,
  getUserInfoForUid2,
  getUser,
  createDummyUser,
  getPid,
  getPidPromise,
  getPidForParticipant,
  getSocialInfoForUsers
};
