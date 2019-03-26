const pg = require('./db/pg-query');
const User = require('./user');
const MPromise = require('./utils/metered').MPromise;

function createXidRecord(ownerUid, uid, xid, x_profile_image_url, x_name, x_email) {
  return pg.queryP("insert into xids (owner, uid, xid, x_profile_image_url, x_name, x_email) values ($1, $2, $3, $4, $5, $6) " +
    "on conflict (owner, xid) do nothing;", [
    ownerUid,
    uid,
    xid,
    x_profile_image_url || null,
    x_name || null,
    x_email || null,
  ]);
}

function createXidRecordByZid(zid, uid, xid, x_profile_image_url, x_name, x_email) {
  return getConversationInfo(zid).then((conv) => {
    const shouldCreateXidRecord = conv.use_xid_whitelist ? isXidWhitelisted(conv.owner, xid) : Promise.resolve(true);
    return shouldCreateXidRecord.then((should) => {
      if (!should) {
        throw new Error("polis_err_xid_not_whitelisted_2");
      }
      return pg.queryP("insert into xids (owner, uid, xid, x_profile_image_url, x_name, x_email) values ((select org_id from conversations where zid = ($1)), $2, $3, $4, $5, $6) " +
        "on conflict (owner, xid) do nothing;", [
        zid,
        uid,
        xid,
        x_profile_image_url || null,
        x_name || null,
        x_email || null,
      ]);
    });
  });
}

function getXidRecord(xid, zid) {
  return pg.queryP("select * from xids where xid = ($1) and owner = (select org_id from conversations where zid = ($2));", [xid, zid]);
}

function getXidRecordByXidOwnerId(xid, owner, zid_optional, x_profile_image_url, x_name, x_email, createIfMissing) {
  return pg.queryP("select * from xids where xid = ($1) and owner = ($2);", [xid, owner]).then(function(rows) {
    if (!rows || !rows.length) {
      console.log('no xInfo yet');
      if (!createIfMissing) {
        return null;
      }

      let shouldCreateXidEntryPromise = !zid_optional ? Promise.resolve(true) : getConversationInfo(zid_optional).then((conv) => {
        return conv.use_xid_whitelist ? isXidWhitelisted(owner, xid) : Promise.resolve(true);
      });

      return shouldCreateXidEntryPromise.then((should) => {
        if (!should) {
          return null;
        }
        return User.createDummyUser().then((newUid) => {
          console.log('created dummy');
          return createXidRecord(owner, newUid, xid, x_profile_image_url||null, x_name||null, x_email||null).then(() => {
            console.log('created xInfo');
            return [{
              uid: newUid,
              owner: owner,
              xid: xid,
              x_profile_image_url: x_profile_image_url,
              x_name: x_name,
              x_email: x_email,
            }];
          });
        });
      });
    }
    return rows;
  });
}
function getXidStuff(xid, zid) {
  return getXidRecord(xid, zid).then((rows) => {
    if (!rows || !rows.length) {
      return "noXidRecord";
    }
    let xidRecordForPtpt = rows[0];
    if (xidRecordForPtpt) {
      return User.getPidPromise(zid, xidRecordForPtpt.uid, true).then((pidForXid) => {
        xidRecordForPtpt.pid = pidForXid;
        return xidRecordForPtpt;
      });
    }
    return xidRecordForPtpt;
  });
}

function isXidWhitelisted(owner, xid) {
  return pg.queryP("select * from xid_whitelist where owner = ($1) and xid = ($2);", [owner, xid]).then((rows) => {
    return !!rows && rows.length > 0;
  });
}


function getConversationInfo(zid) {
  return new MPromise("getConversationInfo", function(resolve, reject) {
    pg.query("SELECT * FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result.rows[0]);
      }
    });
  });
}

function getConversationInfoByConversationId(conversation_id) {
  return new MPromise("getConversationInfoByConversationId", function(resolve, reject) {
    pg.query("SELECT * FROM conversations WHERE zid = (select zid from zinvites where zinvite = ($1));", [conversation_id], function(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result.rows[0]);
      }
    });
  });
}

module.exports = {
  createXidRecordByZid,
  getXidRecord,
  getXidRecordByXidOwnerId,
  getXidStuff,
  isXidWhitelisted,
  getConversationInfo,
  getConversationInfoByConversationId
};