const _ = require('underscore');
const pg = require('../db/pg-query');
const fail = require('../log').fail;
const polisConfig = require('../polis-config');
const i18n = require('i18n');

i18n.configure({
  locales:['en', 'zh-TW'],
  directory: __dirname + '/locales'
});

function createUser(req, res, COOKIES) {
  let hname = req.p.hname;
  let password = req.p.password;
  let password2 = req.p.password2; // for verification
  let email = req.p.email;
  let oinvite = req.p.oinvite;
  let zinvite = req.p.zinvite;
  let referrer = req.cookies[COOKIES.REFERRER];
  let organization = req.p.organization;
  let gatekeeperTosPrivacy = req.p.gatekeeperTosPrivacy;
  let lti_user_id = req.p.lti_user_id;
  let lti_user_image = req.p.lti_user_image;
  let lti_context_id = req.p.lti_context_id;
  let tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
  let afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

  let site_id = void 0;
  if (req.p.encodedParams) {
    let decodedParams = decodeParams(req.p.encodedParams);
    if (decodedParams.site_id) {
      // NOTE: we could have just allowed site_id to be passed as a normal param, but then we'd need to think about securing that with some other token sooner.
      // I think we can get by with this obscure scheme for a bit.
      // TODO_SECURITY add the extra token associated with the site_id owner.
      site_id = decodedParams.site_id;
    }
  }

  let shouldAddToIntercom = req.p.owner;
  if (req.p.lti_user_id) {
    shouldAddToIntercom = false;
  }

  if (password2 && (password !== password2)) {
    fail(res, 400, "Passwords do not match.");
    return;
  }
  if (!gatekeeperTosPrivacy) {
    fail(res, 400, "polis_err_reg_need_tos");
    return;
  }
  if (!email) {
    fail(res, 400, "polis_err_reg_need_email");
    return;
  }
  if (!hname) {
    fail(res, 400, "polis_err_reg_need_name");
    return;
  }
  if (!password) {
    fail(res, 400, "polis_err_reg_password");
    return;
  }
  if (password.length < 6) {
    fail(res, 400, "polis_err_reg_password_too_short");
    return;
  }
  if (!_.contains(email, "@") || email.length < 3) {
    fail(res, 400, "polis_err_reg_bad_email");
    return;
  }

  pg.queryP("SELECT * FROM users WHERE email = ($1)", [email]).then(function (rows) {

    if (rows.length > 0) {
      fail(res, 403, "polis_err_reg_user_with_that_email_exists");
      return;
    }

    require('../auth/password').generateHashedPassword(password, function (err, hashedPassword) {
      if (err) {
        fail(res, 500, "polis_err_generating_hash", err);
        return;
      }
      let query = "insert into users " +
        "(email, hname, zinvite, oinvite, is_owner" + (site_id ? ", site_id" : "") + ") VALUES " + // TODO use sql query builder
        "($1, $2, $3, $4, $5" + (site_id ? ", $6" : "") + ") " + // TODO use sql query builder
        "returning uid;";
      let vals =
        [email, hname, zinvite || null, oinvite || null, true];
      if (site_id) {
        vals.push(site_id); // TODO use sql query builder
      }

      doSendVerification(req, email);

      pg.query(query, vals, function (err, result) {
        if (err) {
          winston.log("info", err);
          fail(res, 500, "polis_err_reg_failed_to_add_user_record", err);
          return;
        }
        let uid = result && result.rows && result.rows[0] && result.rows[0].uid;

        pg.query("insert into jianiuevyew (uid, pwhash) values ($1, $2);", [uid, hashedPassword], function (err, results) {
          if (err) {
            winston.log("info", err);
            fail(res, 500, "polis_err_reg_failed_to_add_user_record", err);
            return;
          }


          startSession(uid, function (err, token) {
            if (err) {
              fail(res, 500, "polis_err_reg_failed_to_start_session", err);
              return;
            }
            addCookies(req, res, token, uid).then(function () {

              let ltiUserPromise = lti_user_id ?
                addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) :
                Promise.resolve();
              let ltiContextMembershipPromise = lti_context_id ?
                addLtiContextMembership(uid, lti_context_id, tool_consumer_instance_guid) :
                Promise.resolve();
              Promise.all([ltiUserPromise, ltiContextMembershipPromise]).then(function () {
                if (lti_user_id) {
                  if (afterJoinRedirectUrl) {
                    res.redirect(afterJoinRedirectUrl);
                  } else {
                    renderLtiLinkageSuccessPage(req, res, {
                      // may include token here too
                      context_id: lti_context_id,
                      uid: uid,
                      hname: hname,
                      email: email,
                    });
                  }
                } else {
                  res.json({
                    uid: uid,
                    hname: hname,
                    email: email,
                    // token: token
                  });
                }
              }).catch(function (err) {
                fail(res, 500, "polis_err_creating_user_associating_with_lti_user", err);
              });

              if (shouldAddToIntercom) {
                let params = {
                  "email": email,
                  "name": hname,
                  "user_id": uid,
                };
                let customData = {};
                if (referrer) {
                  customData.referrer = referrer;
                }
                if (organization) {
                  customData.org = organization;
                }
                customData.uid = uid;
                if (_.keys(customData).length) {
                  params.custom_data = customData;
                }
                // Do not know what is intercom, just skip
                if (intercom.createUser) {
                  intercom.createUser(params, function (err, res) {
                    if (err) {
                      winston.log("info", err);
                      console.error("polis_err_intercom_create_user_fail");
                      winston.log("info", params);
                      yell("polis_err_intercom_create_user_fail");
                      return;
                    }
                  });
                }
              }
            }, function (err) {
              fail(res, 500, "polis_err_adding_cookies", err);
            }).catch(function (err) {
              fail(res, 500, "polis_err_adding_user", err);
            });
          }); // end startSession
        }); // end insert pwhash
      }); // end insert user
    }); // end generateHashedPassword

  }, function (err) {
    fail(res, 500, "polis_err_reg_checking_existing_users", err);
  });
}

function doSendVerification(req, email) {
  return generateTokenP(30, false).then(function (einvite) {
    return pg.queryP("insert into einvites (email, einvite) values ($1, $2);", [email, einvite]).then(function (rows) {
      return sendVerificationEmail(req, email, einvite);
    });
  });
}

function sendVerificationEmail(req, email, einvite) {
  let serverName = polisConfig.get('SERVICE_URL');
  if (!serverName) {
    console.error('Config SERVICE_URL is not set!');
    return;
  }
  let body = i18n.__("PolisVerification", serverName, einvite);
  return require('../email/mailgun').sendText(
    polisConfig.get('POLIS_FROM_ADDRESS'),
    email,
    i18n.__("Polis verification"),
    body);
}

function decodeParams(encodedStringifiedJson) {
  if (!encodedStringifiedJson.match(/^\/?ep1_/)) {
    throw new Error("wrong encoded params prefix");
  }
  if (encodedStringifiedJson[0] === "/") {
    encodedStringifiedJson = encodedStringifiedJson.slice(5);
  } else {
    encodedStringifiedJson = encodedStringifiedJson.slice(4);
  }
  let stringifiedJson = hexToStr(encodedStringifiedJson);
  let o = JSON.parse(stringifiedJson);
  return o;
}

function generateTokenP(len, pseudoRandomOk) {
  return new Promise(function (resolve, reject) {
    generateToken(len, pseudoRandomOk, function (err, token) {
      if (err) {
        reject(err);
      } else {
        resolve(token);
      }
    });
  });
}

function generateToken(len, pseudoRandomOk, callback) {
  // TODO store up a buffer of random bytes sampled at random times to reduce predictability. (or see if crypto module does this for us)
  // TODO if you want more readable tokens, see ReadableIds
  let gen;
  if (pseudoRandomOk) {
    gen = crypto.pseudoRandomBytes;
  } else {
    gen = crypto.randomBytes;
  }
  gen(len, function (err, buf) {
    if (err) {
      return callback(err);
    }

    let prettyToken = buf.toString('base64')
      .replace(/\//g, 'A').replace(/\+/g, 'B') // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B. Don't want to use any punctuation.)
      .replace(/l/g, 'C') // looks like '1'
      .replace(/L/g, 'D') // looks like '1'
      .replace(/o/g, 'E') // looks like 0
      .replace(/O/g, 'F') // looks lke 0
      .replace(/1/g, 'G') // looks like 'l'
      .replace(/0/g, 'H') // looks like 'O'
      .replace(/I/g, 'J') // looks like 'l'
      .replace(/g/g, 'K') // looks like 'g'
      .replace(/G/g, 'M') // looks like 'g'
      .replace(/q/g, 'N') // looks like 'q'
      .replace(/Q/g, 'R') // looks like 'q'
    ;
    // replace first character with a number between 2 and 9 (avoiding 0 and 1 since they look like l and O)
    prettyToken = _.random(2, 9) + prettyToken.slice(1);
    prettyToken = prettyToken.toLowerCase();
    prettyToken = prettyToken.slice(0, len); // in case it's too long

    callback(0, prettyToken);
  });
}

// function generateApiKeyForUser(uid, optionalPrefix) {
//   let parts = ["pkey"];
//   let len = 32;
//   if (!_.isUndefined(optionalPrefix)) {
//     parts.push(optionalPrefix);
//   }
//   len -= parts[0].length;
//   len -= (parts.length - 1); // the underscores
//   parts.forEach(function(part) {
//     len -= part.length;
//   });
//   return generateTokenP(len, false).then(function(token) {
//     parts.push(token);
//     let apikey = parts.join("_");
//     return apikey;
//   });
// }

// function addApiKeyForUser(uid, optionalPrefix) {
//   return generateApiKeyForUser(uid, optionalPrefix).then(function(apikey) {
//     return pgQueryP("insert into apikeysndvweifu (uid, apikey)  VALUES ($1, $2);", [uid, apikey]);
//   });
// }


// function getApiKeysTruncated(uid) {
//   return pgQueryP_readOnly("select * from apikeysndvweifu WHERE uid = ($1);", [uid]).then(function(rows) {
//     if (!rows || !rows.length) {
//       return [];
//     }
//     return rows.map(function(row) {
//       return {
//         apikeyTruncated: row.apikey.slice(0, 10) + "...",
//         created: row.created,
//       };
//     });
//   });
// }

// function createApiKey(uid) {
//   return generateTokenP(17, false).then(function(token) {
//     let apikey = "pkey_" + token;
//     return pgQueryP("insert into apikeysndvweifu (uid, apikey) values ($1, $2) returning *;", [uid, apikey]).then(function(row) {
//       return {
//         apikey: apikey,
//         created: row.created,
//       };
//     });
//   });
// }

// function deleteApiKey(uid, apikeyTruncated) {
//   // strip trailing "..."
//   apikeyTruncated = apikeyTruncated.slice(0, apikeyTruncated.indexOf("."));
//   // basic sanitizing - replace unexpected characters with x's.
//   apikeyTruncated = apikeyTruncated.replace(/[^a-zA-Z0-9_]/g, 'x');
//   return pgQueryP("delete from apikeysndvweifu where uid = ($1) and apikey ~ '^" + apikeyTruncated + "';", [uid]);
// }


// function addApiKeyForUsersBulk(uids, optionalPrefix) {
//     let promises = uids.map(function(uid) {
//         return generateApiKeyForUser(uid, optionalPrefix);
//     });
//     return Promise.all(promises).then(function(apikeys) {
//         let query = "insert into apikeysndvweifu (uid, apikey)  VALUES ";
//         let pairs = [];
//         for (var i = 0; i < uids.length; i++) {
//             let uid = uids[i];
//             let apikey = apikeys[i];
//             pairs.push("(" + uid + ', \'' + apikey + '\')');
//         }
//         query += pairs.join(',');
//         query += 'returning uid;';
//         return pgQueryP(query, []);
//     });
// }

// let uidsX = [];
// for (var i = 200200; i < 300000; i++) {
//     uidsX.push(i);
// }
// addApiKeyForUsersBulk(uidsX, "test23").then(function(uids) {
//     console.log("hihihihi", uids.length);
//     setTimeout(function() { process.exit();}, 3000);
// });

// // let time1 = Date.now();
// createDummyUsersBatch(3 * 1000).then(function(uids) {
//         // let time2 = Date.now();
//         // let dt = time2 - time1;
//         // console.log("time foo" , dt);
//         // console.dir(uids);
//         uids.forEach(function(uid) {
//             console.log("hihihihi", uid);
//         });
//         process.exit(0);

// }).catch(function(err) {
//     console.error("errorfooooo");
//     console.error(err);
// });


function generateAndRegisterZinvite(zid, generateShort) {
  let len = 10;
  if (generateShort) {
    len = 6;
  }
  return generateTokenP(len, false).then(function (zinvite) {
    return pg.queryP('INSERT INTO zinvites (zid, zinvite, created) VALUES ($1, $2, default);', [zid, zinvite]).then(function (rows) {
      return zinvite;
    });
  });
}

module.exports = {
  createUser,
  doSendVerification,
  generateToken,
  generateTokenP,
  generateAndRegisterZinvite
};