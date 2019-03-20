const crypto = require('crypto');
const LruCache = require("lru-cache");
const pg = require('./db/pg-query');

function encrypt(text) {
  const algorithm = 'aes-256-ctr';
  const password = process.env['ENCRYPTION_PASSWORD_00001'];
  const cipher = crypto.createCipher(algorithm, password);
  var crypted = cipher.update(text,'utf8','hex');
  crypted += cipher.final('hex');
  return crypted;
}

function decrypt(text) {
  const algorithm = 'aes-256-ctr';
  const password = process.env['ENCRYPTION_PASSWORD_00001'];
  const decipher = crypto.createDecipher(algorithm, password);
  let dec = decipher.update(text,'hex','utf8');
  dec += decipher.final('utf8');
  return dec;
}

function makeSessionToken() {
  // These can probably be shortened at some point.
  return crypto.randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, "").substr(0, 20);
}

// But we need to squeeze a bit more out of the db right now,
// and generally remove sources of uncertainty about what makes
// various queries slow. And having every single query talk to PG
// adds a lot of variability across the board.
const userTokenCache = new LruCache({
  max: 9000,
});

function getUserInfoForSessionToken(sessionToken, res, cb) {
  let cachedUid = userTokenCache.get(sessionToken);
  if (cachedUid) {
    cb(null, cachedUid);
    return;
  }
  pg.query("select uid from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
    if (err) {
      console.error("token_fetch_error");
      cb(500);
      return;
    }
    if (!results || !results.rows || !results.rows.length) {
      console.error("token_expired_or_missing");

      cb(403);
      return;
    }
    let uid = results.rows[0].uid;
    userTokenCache.set(sessionToken, uid);
    cb(null, uid);
  });
}


function createPolisLtiToken(tool_consumer_instance_guid, lti_user_id) {
  return ["xPolisLtiToken", tool_consumer_instance_guid, lti_user_id].join(":::");
}

function isPolisLtiToken(token) {
  return token.match(/^xPolisLtiToken/);
}
function isPolisSlackTeamUserToken(token) {
  return token.match(/^xPolisSlackTeamUserToken/);
}

// function sendSlackEvent(slack_team, o) {
//   return pgQueryP("insert into slack_bot_events (slack_team, event) values ($1, $2);", [slack_team, o]);
// }
function sendSlackEvent(o) {
  return pg.queryP("insert into slack_bot_events (event) values ($1);", [o]);
}

function parsePolisLtiToken(token) {
  let parts = token.split(/:::/);
  return {
    // parts[0] === "xPolisLtiToken", don't need that
    tool_consumer_instance_guid: parts[1],
    lti_user_id: parts[2],
  };
}




function getUserInfoForPolisLtiToken(token) {
  let o = parsePolisLtiToken(token);
  return pg.queryP("select uid from lti_users where tool_consumer_instance_guid = $1 and lti_user_id = $2", [
    o.tool_consumer_instance_guid,
    o.lti_user_id,
  ]).then(function(rows) {
    return rows[0].uid;
  });
}

function startSession(uid, cb) {
  let token = makeSessionToken();
  console.log("info", 'startSession');
  pg.query("insert into auth_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(err, repliesSetToken) {
    if (err) {
      cb(err);
      return;
    }
    console.log("info", 'startSession: token set.');
    cb(null, token);
  });
}

function endSession(sessionToken, cb) {
  pg.query("delete from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
    if (err) {
      cb(err);
      return;
    }
    cb(null);
  });
}


function setupPwReset(uid, cb) {
  function makePwResetToken() {
    // These can probably be shortened at some point.
    return crypto.randomBytes(140).toString('base64').replace(/[^A-Za-z0-9]/g, "").substr(0, 100);
  }
  let token = makePwResetToken();
  pg.query("insert into pwreset_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(errSetToken, repliesSetToken) {
    if (errSetToken) {
      cb(errSetToken);
      return;
    }
    cb(null, token);
  });
}

function getUidForPwResetToken(pwresettoken, cb) {
  // TODO "and created > timestamp - x"
  pg.query("select uid from pwreset_tokens where token = ($1);", [pwresettoken], function(errGetToken, results) {
    if (errGetToken) {
      console.error("pwresettoken_fetch_error");
      cb(500);
      return;
    }
    if (!results || !results.rows || !results.rows.length) {
      console.error("token_expired_or_missing");
      cb(403);
      return;
    }
    cb(null, {
      uid: results.rows[0].uid,
    });
  });
}

function clearPwResetToken(pwresettoken, cb) {
  pg.query("delete from pwreset_tokens where token = ($1);", [pwresettoken], function(errDelToken, repliesSetToken) {
    if (errDelToken) {
      cb(errDelToken);
      return;
    }
    cb(null);
  });
}

module.exports = {
  encrypt,
  decrypt,
  makeSessionToken,
  getUserInfoForSessionToken,
  createPolisLtiToken,
  isPolisLtiToken,
  isPolisSlackTeamUserToken,
  sendSlackEvent,
  getUserInfoForPolisLtiToken,
  startSession,
  endSession,
  setupPwReset,
  getUidForPwResetToken,
  clearPwResetToken
};
