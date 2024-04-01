import crypto from 'crypto';
import LruCache from 'lru-cache';
import Config from './config.js';
import pg from './db/pg-query.js';
import logger from './utils/logger.js';
function encrypt(text) {
  const algorithm = 'aes-256-ctr';
  const password = Config.encryptionPassword;
  const cipher = crypto.createCipher(algorithm, password);
  var crypted = cipher.update(text, 'utf8', 'hex');
  crypted += cipher.final('hex');
  return crypted;
}
function decrypt(text) {
  const algorithm = 'aes-256-ctr';
  const password = Config.encryptionPassword;
  const decipher = crypto.createDecipher(algorithm, password);
  var dec = decipher.update(text, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}
decrypt;
function makeSessionToken() {
  return crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .substr(0, 20);
}
const userTokenCache = new LruCache({
  max: 9000
});
function getUserInfoForSessionToken(sessionToken, res, cb) {
  let cachedUid = userTokenCache.get(sessionToken);
  if (cachedUid) {
    cb(null, cachedUid);
    return;
  }
  pg.query('select uid from auth_tokens where token = ($1);', [sessionToken], function (err, results) {
    if (err) {
      logger.error('token_fetch_error', err);
      cb(500);
      return;
    }
    if (!results || !results.rows || !results.rows.length) {
      logger.error('token_expired_or_missing');
      cb(403);
      return;
    }
    let uid = results.rows[0].uid;
    userTokenCache.set(sessionToken, uid);
    cb(null, uid);
  });
}
function startSession(uid, cb) {
  let token = makeSessionToken();
  logger.info('startSession');
  pg.query(
    'insert into auth_tokens (uid, token, created) values ($1, $2, default);',
    [uid, token],
    function (err, repliesSetToken) {
      if (err) {
        cb(err);
        return;
      }
      logger.info('startSession: token set.');
      cb(null, token);
    }
  );
}
function endSession(sessionToken, cb) {
  pg.query('delete from auth_tokens where token = ($1);', [sessionToken], function (err, results) {
    if (err) {
      cb(err);
      return;
    }
    cb(null);
  });
}
function setupPwReset(uid, cb) {
  function makePwResetToken() {
    return crypto
      .randomBytes(140)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, '')
      .substr(0, 100);
  }
  let token = makePwResetToken();
  pg.query(
    'insert into pwreset_tokens (uid, token, created) values ($1, $2, default);',
    [uid, token],
    function (errSetToken, repliesSetToken) {
      if (errSetToken) {
        cb(errSetToken);
        return;
      }
      cb(null, token);
    }
  );
}
function getUidForPwResetToken(pwresettoken, cb) {
  pg.query('select uid from pwreset_tokens where token = ($1);', [pwresettoken], function (errGetToken, results) {
    if (errGetToken) {
      logger.error('pwresettoken_fetch_error', errGetToken);
      cb(500);
      return;
    }
    if (!results || !results.rows || !results.rows.length) {
      logger.error('token_expired_or_missing');
      cb(403);
      return;
    }
    cb(null, {
      uid: results.rows[0].uid
    });
  });
}
function clearPwResetToken(pwresettoken, cb) {
  pg.query('delete from pwreset_tokens where token = ($1);', [pwresettoken], function (errDelToken, repliesSetToken) {
    if (errDelToken) {
      cb(errDelToken);
      return;
    }
    cb(null);
  });
}
export {
  encrypt,
  decrypt,
  makeSessionToken,
  getUserInfoForSessionToken,
  startSession,
  endSession,
  setupPwReset,
  getUidForPwResetToken,
  clearPwResetToken
};
export default {
  encrypt,
  decrypt,
  makeSessionToken,
  getUserInfoForSessionToken,
  startSession,
  endSession,
  setupPwReset,
  getUidForPwResetToken,
  clearPwResetToken
};
