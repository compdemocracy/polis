function handle_GET_facebook_delete(
  req: { p: any },
  res: { json: (arg0: {}) => void }
) {
  deleteFacebookUserRecord(req.p)
    .then(function () {
      res.json({});
    })
    .catch(function (err: any) {
      fail(res, 500, err);
    });
}

function getFriends(fb_access_token: any) {
  function getMoreFriends(friendsSoFar: any[], urlForNextCall: any) {
    // urlForNextCall includes access token
    return request.get(urlForNextCall).then(
      function (response: { data: string | any[]; paging: { next: any } }) {
        const len = response.data.length;
        if (len) {
          for (let i = 0; i < len; i++) {
            friendsSoFar.push(response.data[i]);
          }
          if (response.paging.next) {
            return getMoreFriends(friendsSoFar, response.paging.next);
          }
          return friendsSoFar;
        } else {
          return friendsSoFar;
        }
      },
      function (err: any) {
        emailBadProblemTime("getMoreFriends failed");
        return friendsSoFar;
      }
    );
  }
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: any) => void
  ) {
    FB.setAccessToken(fb_access_token);
    FB.api(
      "/me/friends",
      function (response: {
        error: any;
        data: any[];
        paging: { next: any };
      }) {
        if (response && !response.error) {
          const friendsSoFar = response.data;
          if (response.data.length && response.paging.next) {
            getMoreFriends(friendsSoFar, response.paging.next).then(
              resolve,
              reject
            );
          } else {
            resolve(friendsSoFar || []);
          }
        } else {
          reject(response);
        }
      }
    );
  });
}

function getLocationInfo(fb_access_token: any, location: { id: string }) {
  return new Promise(function (resolve: (arg0: {}) => void, reject: any) {
    if (location && location.id) {
      FB.setAccessToken(fb_access_token);
      FB.api("/" + location.id, function (locationResponse: any) {
        resolve(locationResponse);
      });
    } else {
      resolve({});
    }
  });
}

function handle_POST_auth_facebook(
  req: {
    p: {
      response?: string;
      locationInfo?: any;
      fb_friends_response?: string;
    };
    headers?: { referer: string };
    cookies?: any;
  },
  res: any
) {
  const response = JSON.parse(req?.p?.response || "");
  const fb_access_token =
    response && response.authResponse && response.authResponse.accessToken;
  if (!fb_access_token) {
    emailBadProblemTime(
      "polis_err_missing_fb_access_token " +
        req?.headers?.referer +
        "\n\n" +
        req.p.response
    );
    console.log(req.p.response);
    console.log(JSON.stringify(req.headers));
    fail(res, 500, "polis_err_missing_fb_access_token");
    return;
  }
  const fields = [
    "email",
    "first_name",
    "friends",
    "gender",
    "id",
    "is_verified",
    "last_name",
    "link",
    "locale",
    "location",
    "name",
    "timezone",
    "updated_time",
    "verified",
  ];

  FB.setAccessToken(fb_access_token);
  FB.api(
    "me",
    {
      fields: fields,
    },
    function (fbRes: { error: any; friends: string | any[]; location: any }) {
      if (!fbRes || fbRes.error) {
        fail(res, 500, "polis_err_fb_auth_check", fbRes && fbRes.error);
        return;
      }

      const friendsPromise =
        fbRes && fbRes.friends && fbRes.friends.length
          ? getFriends(fb_access_token)
          : Promise.resolve([]);

      Promise.all([
        getLocationInfo(fb_access_token, fbRes.location),
        friendsPromise,
      ]).then(function (a: any[]) {
        const locationResponse = a[0];
        const friends = a[1];

        if (locationResponse) {
          req.p.locationInfo = locationResponse;
        }
        if (friends) {
          req.p.fb_friends_response = JSON.stringify(friends);
        }
        response.locationInfo = locationResponse;
        do_handle_POST_auth_facebook(req, res, {
          locationInfo: locationResponse,
          friends: friends,
          info: _.pick(fbRes, fields),
        });
      });
    }
  );
}

function do_handle_POST_auth_facebook(
  req: {
    p: {
      response?: string;
      password?: any;
      uid?: any;
      fb_granted_scopes?: any;
      fb_friends_response?: any;
    };
    cookies?: { [x: string]: any };
  },
  res: {
    json: (arg0: { uid?: any; hname: any; email: any }) => void;
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: {
        (arg0: { uid?: any; hname: any; email: any }): void;
        new (): any;
      };
      send: { (arg0: string): void; new (): any };
    };
  },
  o: { locationInfo?: any; friends: any; info: any }
) {
  // If a pol.is user record exists, and someone logs in with a facebook account that has the same email address,
  // we should bind that facebook account to the pol.is account, and let the user sign in.
  const TRUST_FB_TO_VALIDATE_EMAIL = true;
  const email = o.info.email;
  const hname = o.info.name;
  const fb_friends_response = o.friends;
  const fb_user_id = o.info.id;
  const response = JSON.parse(req?.p?.response || "");
  const fb_public_profile = o.info;
  const fb_login_status = response.status;
  const fb_access_token = response.authResponse.accessToken;
  const verified = o.info.verified;
  const password = req.p.password;
  const uid = req.p.uid;

  const fbUserRecord = {
    // uid provided later
    fb_user_id: fb_user_id,
    fb_public_profile: fb_public_profile,
    fb_login_status: fb_login_status,
    fb_access_token: fb_access_token,
    fb_granted_scopes: req.p.fb_granted_scopes,
    fb_friends_response: req.p.fb_friends_response || "",
    response: req.p.response,
  };
  function doFbUserHasAccountLinked(user: {
    fb_user_id: any;
    uid: string;
    hname: any;
    email: any;
  }) {
    if (user.fb_user_id === fb_user_id) {
      updateFacebookUserRecord(
        Object.assign(
          {},
          {
            uid: user.uid,
          },
          fbUserRecord
        )
      )
        .then(
          function () {
            const friendsAddedPromise = fb_friends_response
              ? addFacebookFriends(user.uid, fb_friends_response)
              : Promise.resolve();
            return friendsAddedPromise.then(
              function () {
                startSessionAndAddCookies(req, res, user.uid)
                  .then(function () {
                    res.json({
                      uid: user.uid,
                      hname: user.hname,
                      email: user.email
                    });
                  })
                  .catch(function (err: any) {
                    fail(res, 500, "polis_err_reg_fb_start_session2", err);
                  });
              },
              function (err: any) {
                fail(res, 500, "polis_err_linking_fb_friends2", err);
              }
            );
          },
          function (err: any) {
            fail(res, 500, "polis_err_updating_fb_info", err);
          }
        )
        .catch(function (err: any) {
          fail(res, 500, "polis_err_fb_auth_misc", err);
        });
    } else {
      // the user with that email has a different FB account attached
      // so clobber the old facebook_users record and add the new one.
      deleteFacebookUserRecord(user).then(
        function () {
          doFbNotLinkedButUserWithEmailExists(user);
        },
        function (err: any) {
          emailBadProblemTime(
            "facebook auth where user exists with different facebook account " +
              user.uid
          );
          fail(
            res,
            500,
            "polis_err_reg_fb_user_exists_with_different_account"
          );
        }
      );
    }
  }

  function doFbNotLinkedButUserWithEmailExists(user: { uid?: any }) {
    // user for this email exists, but does not have FB account linked.
    // user will be prompted for their password, and client will repeat the call with password
    // fail(res, 409, "polis_err_reg_user_exits_with_email_but_has_no_facebook_linked")
    if (!TRUST_FB_TO_VALIDATE_EMAIL && !password) {
      fail(res, 403, "polis_err_user_with_this_email_exists " + email);
    } else {
      const pwPromise = TRUST_FB_TO_VALIDATE_EMAIL
        ? Promise.resolve(true)
        : Password.checkPassword(user.uid, password || "");
      pwPromise.then(
        function (ok: any) {
          if (ok) {
            createFacebookUserRecord(
              Object.assign(
                {},
                {
                  uid: user.uid,
                },
                fbUserRecord
              )
            )
              .then(
                function () {
                  const friendsAddedPromise = fb_friends_response
                    ? addFacebookFriends(user.uid, fb_friends_response)
                    : Promise.resolve();
                  return friendsAddedPromise
                    .then(
                      function () {
                        return startSessionAndAddCookies(
                          req,
                          res,
                          user.uid
                        ).then(function () {
                          return user;
                        });
                      },
                      function (err: any) {
                        fail(res, 500, "polis_err_linking_fb_friends", err);
                      }
                    )
                    .then(
                      function (user: { uid?: any; hname: any; email: any }) {
                        res.status(200).json({
                          uid: user.uid,
                          hname: user.hname,
                          email: user.email,
                        });
                      },
                      function (err: any) {
                        fail(res, 500, "polis_err_linking_fb_misc", err);
                      }
                    );
                },
                function (err: any) {
                  fail(
                    res,
                    500,
                    "polis_err_linking_fb_to_existing_polis_account",
                    err
                  );
                }
              )
              .catch(function (err: any) {
                fail(
                  res,
                  500,
                  "polis_err_linking_fb_to_existing_polis_account_misc",
                  err
                );
              });
          } else {
            fail(res, 403, "polis_err_password_mismatch");
          }
        },
        function (err: any) {
          fail(res, 500, "polis_err_password_check");
        }
      );
    }
  }

  function doFbNoUserExistsYet(user: any) {
    let promise;
    if (uid) {
      winston.log("info", "fb1 5a...");
      // user record already exists, so populate that in case it has missing info
      promise = Promise.all([
        pgQueryP("select * from users where uid = ($1);", [uid]),
        pgQueryP(
          "update users set hname = ($2) where uid = ($1) and hname is NULL;",
          [uid, hname]
        ),
        pgQueryP(
          "update users set email = ($2) where uid = ($1) and email is NULL;",
          [uid, email]
        ),
      ]).then(function (o: any[][]) {
        const user = o[0][0];
        winston.log("info", "fb1 5a");
        winston.log("info", user);
        winston.log("info", "end fb1 5a");
        return user;
      });
      winston.log("info", "fb1 5a....");
    } else {
      winston.log("info", "fb1 5b...");
      const query =
        "insert into users " +
        "(email, hname) VALUES " +
        "($1, $2) " +
        "returning *;";
      promise = pgQueryP(query, [email, hname]).then(function (
        rows: string | any[]
      ) {
        const user = (rows && rows.length && rows[0]) || null;
        winston.log("info", "fb1 5b");
        winston.log("info", user);
        winston.log("info", "end fb1 5b");
        return user;
      });
    }
    // Create user record
    promise
      .then(function (user: any) {
        winston.log("info", "fb1 4");
        winston.log("info", user);
        winston.log("info", "end fb1 4");
        return createFacebookUserRecord(
          Object.assign({}, user, fbUserRecord)
        ).then(function () {
          return user;
        });
      })
      .then(
        function (user: { uid?: any }) {
          winston.log("info", "fb1 3");
          winston.log("info", user);
          winston.log("info", "end fb1 3");
          if (fb_friends_response) {
            return addFacebookFriends(user.uid, fb_friends_response).then(
              function () {
                return user;
              }
            );
          } else {
            // no friends, or this user is first polis user among his/her friends.
            return user;
          }
        },
        function (err: any) {
          fail(res, 500, "polis_err_reg_fb_user_creating_record2", err);
        }
      )
      .then(
        function (user: { uid?: any }) {
          winston.log("info", "fb1 2");
          winston.log("info", user);
          winston.log("info", "end fb1 2");
          const uid = user.uid;
          return startSessionAndAddCookies(req, res, uid).then(
            function () {
              return user;
            },
            function (err: any) {
              fail(res, 500, "polis_err_reg_fb_user_creating_record3", err);
            }
          );
        },
        function (err: any) {
          fail(res, 500, "polis_err_reg_fb_user_creating_record", err);
        }
      )
      .then(
        function (user: { uid?: any; hname: any; email: any }) {
          winston.log("info", "fb1");
          winston.log("info", user);
          winston.log("info", "end fb1");
          res.json({
            uid: user.uid,
            hname: user.hname,
            email: user.email
          });
        },
        function (err: any) {
          fail(res, 500, "polis_err_reg_fb_user_misc22", err);
        }
      )
      .catch(function (err: any) {
        fail(res, 500, "polis_err_reg_fb_user_misc2", err);
      });
  }

  let emailVerifiedPromise = Promise.resolve(true);
  if (!verified) {
    if (email) {
      emailVerifiedPromise = isEmailVerified(email);
    } else {
      emailVerifiedPromise = Promise.resolve(false);
    }
  }

  Promise.all([emailVerifiedPromise]).then(function (a: any[]) {
    const isVerifiedByPolisOrFacebook = a[0];

    if (!isVerifiedByPolisOrFacebook) {
      if (email) {
        doSendVerification(req, email);
        res.status(403).send("polis_err_reg_fb_verification_email_sent");
        return;
      } else {
        res
          .status(403)
          .send("polis_err_reg_fb_verification_noemail_unverified");
        return;
      }
    }

    pgQueryP(
      "select users.*, facebook_users.fb_user_id from users left join facebook_users on users.uid = facebook_users.uid " +
        "where users.email = ($1) " +
        "   or facebook_users.fb_user_id = ($2) " +
        ";",
      [email, fb_user_id]
    )
      .then(
        function (rows: string | any[]) {
          let user = (rows && rows.length && rows[0]) || null;
          if (rows && rows.length > 1) {
            // the auth provided us with email and fb_user_id where the email is one polis user, and the fb_user_id is for another.
            // go with the one matching the fb_user_id in this case, and leave the email matching account alone.
            user = _.find(rows, function (row: { fb_user_id: any }) {
              return row.fb_user_id === fb_user_id;
            });
          }
          if (user) {
            if (user.fb_user_id) {
              doFbUserHasAccountLinked(user);
            } else {
              doFbNotLinkedButUserWithEmailExists(user);
            }
          } else {
            doFbNoUserExistsYet(user);
          }
        },
        function (err: any) {
          fail(res, 500, "polis_err_reg_fb_user_looking_up_email", err);
        }
      )
      .catch(function (err: any) {
        fail(res, 500, "polis_err_reg_fb_user_misc", err);
      });
  });
} // end do_handle_POST_auth_facebook