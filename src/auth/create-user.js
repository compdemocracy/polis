const pg = require('../db/pg-query');

function createUser(req, res) {
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

  pg.queryP("SELECT * FROM users WHERE email = ($1)", [email]).then(function(rows) {

    if (rows.length > 0) {
      fail(res, 403, "polis_err_reg_user_with_that_email_exists");
      return;
    }

    generateHashedPassword(password, function(err, hashedPassword) {
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

      pg.query(query, vals, function(err, result) {
        if (err) {
          winston.log("info", err);
          fail(res, 500, "polis_err_reg_failed_to_add_user_record", err);
          return;
        }
        let uid = result && result.rows && result.rows[0] && result.rows[0].uid;

        pg.query("insert into jianiuevyew (uid, pwhash) values ($1, $2);", [uid, hashedPassword], function(err, results) {
          if (err) {
            winston.log("info", err);
            fail(res, 500, "polis_err_reg_failed_to_add_user_record", err);
            return;
          }


          startSession(uid, function(err, token) {
            if (err) {
              fail(res, 500, "polis_err_reg_failed_to_start_session", err);
              return;
            }
            addCookies(req, res, token, uid).then(function() {

              let ltiUserPromise = lti_user_id ?
                addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) :
                Promise.resolve();
              let ltiContextMembershipPromise = lti_context_id ?
                addLtiContextMembership(uid, lti_context_id, tool_consumer_instance_guid) :
                Promise.resolve();
              Promise.all([ltiUserPromise, ltiContextMembershipPromise]).then(function() {
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
              }).catch(function(err) {
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
            }, function(err) {
              fail(res, 500, "polis_err_adding_cookies", err);
            }).catch(function(err) {
              fail(res, 500, "polis_err_adding_user", err);
            });
          }); // end startSession
        }); // end insert pwhash
      }); // end insert user
    }); // end generateHashedPassword

  }, function(err) {
    fail(res, 500, "polis_err_reg_checking_existing_users", err);
  });
}

module.exports = {
  createUser
};