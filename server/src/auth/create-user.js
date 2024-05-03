import _ from 'underscore';
import pg from '../db/pg-query.js';
import fail from '../utils/fail.js';
import Config from '../config.js';
import cookies from '../utils/cookies.js';
import Session from '../session.js';
import Utils from '../utils/common.js';
import Password from './password.js';
import emailSenders from '../email/senders.js';
const COOKIES = cookies.COOKIES;
const sendTextEmail = emailSenders.sendTextEmail;
function createUser(req, res) {
  let hname = req.p.hname;
  let password = req.p.password;
  let password2 = req.p.password2;
  let email = req.p.email;
  let oinvite = req.p.oinvite;
  let zinvite = req.p.zinvite;
  let organization = req.p.organization;
  let gatekeeperTosPrivacy = req.p.gatekeeperTosPrivacy;
  let site_id;
  if (req.p.encodedParams) {
    let decodedParams = decodeParams(req.p.encodedParams);
    if (decodedParams.site_id) {
      site_id = decodedParams.site_id;
    }
  }
  if (password2 && password !== password2) {
    fail(res, 400, 'Passwords do not match.');
    return;
  }
  if (!gatekeeperTosPrivacy) {
    fail(res, 400, 'polis_err_reg_need_tos');
    return;
  }
  if (!email) {
    fail(res, 400, 'polis_err_reg_need_email');
    return;
  }
  if (!hname) {
    fail(res, 400, 'polis_err_reg_need_name');
    return;
  }
  if (!password) {
    fail(res, 400, 'polis_err_reg_password');
    return;
  }
  if (password.length < 6) {
    fail(res, 400, 'polis_err_reg_password_too_short');
    return;
  }
  if (!_.contains(email, '@') || email.length < 3) {
    fail(res, 400, 'polis_err_reg_bad_email');
    return;
  }
  pg.queryP('SELECT * FROM users WHERE email = ($1)', [email]).then(
    function (rows) {
      if (rows.length > 0) {
        fail(res, 403, 'polis_err_reg_user_with_that_email_exists');
        return;
      }
      Password.generateHashedPassword(password, function (err, hashedPassword) {
        if (err) {
          fail(res, 500, 'polis_err_generating_hash', err);
          return;
        }
        let query =
          'insert into users ' +
          '(email, hname, zinvite, oinvite, is_owner' +
          (site_id ? ', site_id' : '') +
          ') VALUES ' +
          '($1, $2, $3, $4, $5' +
          (site_id ? ', $6' : '') +
          ') ' +
          'returning uid;';
        let vals = [email, hname, zinvite || null, oinvite || null, true];
        if (site_id) {
          vals.push(site_id);
        }
        pg.query(query, vals, function (err, result) {
          if (err) {
            fail(res, 500, 'polis_err_reg_failed_to_add_user_record', err);
            return;
          }
          let uid = result && result.rows && result.rows[0] && result.rows[0].uid;
          pg.query(
            'insert into jianiuevyew (uid, pwhash) values ($1, $2);',
            [uid, hashedPassword],
            function (err, results) {
              if (err) {
                fail(res, 500, 'polis_err_reg_failed_to_add_user_record', err);
                return;
              }
              Session.startSession(uid, function (err, token) {
                if (err) {
                  fail(res, 500, 'polis_err_reg_failed_to_start_session', err);
                  return;
                }
                cookies
                  .addCookies(req, res, token, uid)
                  .then(function () {
                    res.json({
                      uid: uid,
                      hname: hname,
                      email: email
                    });
                  })
                  .catch(function (err) {
                    fail(res, 500, 'polis_err_adding_user', err);
                  });
              });
            }
          );
        });
      });
    },
    function (err) {
      fail(res, 500, 'polis_err_reg_checking_existing_users', err);
    }
  );
}
function doSendVerification(req, email) {
  return Password.generateTokenP(30, false).then(function (einvite) {
    return pg.queryP('insert into einvites (email, einvite) values ($1, $2);', [email, einvite]).then(function (rows) {
      return sendVerificationEmail(req, email, einvite);
    });
  });
}
function sendVerificationEmail(req, email, einvite) {
  let serverName = Config.getServerNameWithProtocol(req);
  let body = `Welcome to pol.is!

Click this link to verify your email address:

${serverName}/api/v3/verify?e=${einvite}`;
  return sendTextEmail(Config.polisFromAddress, email, 'Polis verification', body);
}
function decodeParams(encodedStringifiedJson) {
  if (typeof encodedStringifiedJson === 'string' && !encodedStringifiedJson.match(/^\/?ep1_/)) {
    throw new Error('wrong encoded params prefix');
  }
  if (encodedStringifiedJson[0] === '/') {
    encodedStringifiedJson = encodedStringifiedJson.slice(5);
  } else {
    encodedStringifiedJson = encodedStringifiedJson.slice(4);
  }
  let stringifiedJson = Utils.hexToStr(encodedStringifiedJson);
  let o = JSON.parse(stringifiedJson);
  return o;
}
function generateAndRegisterZinvite(zid, generateShort) {
  let len = 10;
  if (generateShort) {
    len = 6;
  }
  return Password.generateTokenP(len, false).then(function (zinvite) {
    return pg
      .queryP('INSERT INTO zinvites (zid, zinvite, created) VALUES ($1, $2, default);', [zid, zinvite])
      .then(function (rows) {
        return zinvite;
      });
  });
}
export { createUser, doSendVerification, generateAndRegisterZinvite };
export default { createUser, doSendVerification, generateAndRegisterZinvite };
