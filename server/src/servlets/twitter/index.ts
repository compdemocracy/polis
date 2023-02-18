
function getTwitterRequestToken(returnUrl: string) {
  const oauth = new OAuth.OAuth(
    "https://api.twitter.com/oauth/request_token", // null
    "https://api.twitter.com/oauth/access_token", // null
    Config.twitterConsumerKey, //'your application consumer key',
    Config.twitterConsumerSecret, //'your application secret',
    "1.0A",
    null,
    "HMAC-SHA1"
  );
  const body = {
    oauth_callback: returnUrl,
  };
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: any) => void
  ) {
    oauth.post(
      "https://api.twitter.com/oauth/request_token",
      void 0, //'your user token for this app', //test user token
      void 0, //'your user secret for this app', //test user secret
      body,
      "multipart/form-data",
      function (e: any, data: any, res: any) {
        if (e) {
          console.error("get twitter token failed");
          console.error(e);
          reject(e);
        } else {
          resolve(data);
        }
      }
    );
  });
}

function handle_GET_twitterBtn(
  req: { p: { dest: string; owner: string } },
  res: { redirect: (arg0: string) => void }
) {
  let dest = req.p.dest || "/inbox";
  dest = encodeURIComponent(getServerNameWithProtocol(req) + dest);
  const returnUrl =
    getServerNameWithProtocol(req) +
    "/api/v3/twitter_oauth_callback?owner=" +
    req.p.owner +
    "&dest=" +
    dest;

  getTwitterRequestToken(returnUrl)
    .then(function (data: string) {
      winston.log("info", data);
      data += "&callback_url=" + dest;
      res.redirect("https://api.twitter.com/oauth/authenticate?" + data);
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_twitter_auth_01", err);
    });
}

function getTwitterAccessToken(body: {
  oauth_verifier: any;
  oauth_token: any;
}) {
  const oauth = new OAuth.OAuth(
    "https://api.twitter.com/oauth/request_token", // null
    "https://api.twitter.com/oauth/access_token", // null
    Config.twitterConsumerKey, //'your application consumer key',
    Config.twitterConsumerSecret, //'your application secret',
    "1.0A",
    null,
    "HMAC-SHA1"
  );
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: any) => void
  ) {
    oauth.post(
      "https://api.twitter.com/oauth/access_token",
      void 0, //'your user token for this app', //test user token
      void 0, //'your user secret for this app', //test user secret
      body,
      "multipart/form-data",
      function (e: any, data: any, res: any) {
        if (e) {
          console.error("get twitter token failed");
          console.error(e);
          reject(e);
        } else {
          resolve(data);
        }
      }
    );
  });
}

// TODO expire this stuff
const twitterUserInfoCache = new LruCache({
  max: 10000,
});
function getTwitterUserInfo(
  o: { twitter_user_id: any; twitter_screen_name?: any },
  useCache: boolean
) {
  console.log("getTwitterUserInfo", o);

  const twitter_user_id = o.twitter_user_id;
  const twitter_screen_name = o.twitter_screen_name;
  const params: TwitterParameters = {
    // oauth_verifier: req.p.oauth_verifier,
    // oauth_token: req.p.oauth_token,
    // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the
    // header, but this will have been added by the signing process."
  };
  let identifier: string; // this is way sloppy, but should be ok for caching and logging
  if (twitter_user_id) {
    params.user_id = twitter_user_id;
    identifier = twitter_user_id;
  } else if (twitter_screen_name) {
    params.screen_name = twitter_screen_name;
    identifier = twitter_screen_name;
  }

  const oauth = new OAuth.OAuth(
    "https://api.twitter.com/oauth/request_token", // null
    "https://api.twitter.com/oauth/access_token", // null
    Config.twitterConsumerKey, //'your application consumer key',
    Config.twitterConsumerSecret, //'your application secret',
    "1.0A",
    null,
    "HMAC-SHA1"
  );

  return new MPromise(
    "getTwitterUserInfo",
    function (
      resolve: (arg0: any) => void,
      reject: (arg0?: undefined) => void
    ) {
      const cachedCopy = twitterUserInfoCache.get(identifier);
      if (useCache && cachedCopy) {
        return resolve(cachedCopy);
      }
      if (
        suspendedOrPotentiallyProblematicTwitterIds.indexOf(identifier) >= 0
      ) {
        return reject();
      }
      oauth.post(
        "https://api.twitter.com/1.1/users/lookup.json",
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        params,
        "multipart/form-data",
        function (e: any, data: any, res: any) {
          if (e) {
            console.error(
              "get twitter token failed for identifier: " + identifier
            );
            console.error(e);
            suspendedOrPotentiallyProblematicTwitterIds.push(identifier);
            reject(e);
          } else {
            twitterUserInfoCache.set(identifier, data);
            resolve(data);
          }
        }
      );
    }
  );
}

function getTwitterTweetById(twitter_tweet_id: string) {
  const oauth = new OAuth.OAuth(
    "https://api.twitter.com/oauth/request_token", // null
    "https://api.twitter.com/oauth/access_token", // null
    Config.twitterConsumerKey, //'your application consumer key',
    Config.twitterConsumerSecret, //'your application secret',
    "1.0A",
    null,
    "HMAC-SHA1"
  );

  return new MPromise(
    "getTwitterTweet",
    function (resolve: (arg0: any) => void, reject: (arg0: any) => void) {
      oauth.get(
        "https://api.twitter.com/1.1/statuses/show.json?id=" +
          twitter_tweet_id,
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        function (e: any, data: string, res: any) {
          if (e) {
            console.error(" - - - - get twitter tweet failed - - - -");
            console.error(e);
            reject(e);
          } else {
            data = JSON.parse(data);
            console.dir(data);
            resolve(data);
          }
        }
      );
    }
  );
}

// Certain twitter ids may be suspended.
// Twitter will error if we request info on them.
//  so keep a list of these for as long as the server is running,
//  so we don't repeat requests for them.
// This is probably not optimal, but is pretty easy.
const suspendedOrPotentiallyProblematicTwitterIds: any[] = [];
function getTwitterUserInfoBulk(list_of_twitter_user_id: any[]) {
  list_of_twitter_user_id = list_of_twitter_user_id || [];
  const oauth = new OAuth.OAuth(
    "https://api.twitter.com/oauth/request_token", // null
    "https://api.twitter.com/oauth/access_token", // null
    Config.twitterConsumerKey, //'your application consumer key',
    Config.twitterConsumerSecret, //'your application secret',
    "1.0A",
    null,
    "HMAC-SHA1"
  );
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: any) => void
  ) {
    oauth.post(
      "https://api.twitter.com/1.1/users/lookup.json",
      void 0, //'your user token for this app', //test user token
      void 0, //'your user secret for this app', //test user secret
      {
        // oauth_verifier: req.p.oauth_verifier,
        // oauth_token: req.p.oauth_token,
        // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the
        // header, but this will have been added by the signing process."
        user_id: list_of_twitter_user_id.join(","),
      },
      "multipart/form-data",
      function (e: any, data: string, res: any) {
        if (e) {
          console.error("get twitter token failed");
          console.error(e);
          // we should probably check that the error is code 17:
          // { statusCode: 404, data: '{"errors":[{"code":17,"message":"No user matches for specified terms."}]}' }
          list_of_twitter_user_id.forEach(function (id: string) {
            console.log(
              "adding twitter_user_id to suspendedOrPotentiallyProblematicTwitterIds: " +
                id
            );
            suspendedOrPotentiallyProblematicTwitterIds.push(id);
          });
          reject(e);
        } else {
          data = JSON.parse(data);
          resolve(data);
        }
      }
    );
  });
}



function updateSomeTwitterUsers() {
  return (
    pgQueryP_readOnly(
      "select uid, twitter_user_id from twitter_users where modified < (now_as_millis() - 30*60*1000) order by modified desc limit 100;"
    )
      .then(function (results: string | any[]) {
        let twitter_user_ids = _.pluck(results, "twitter_user_id");
        if (results.length === 0) {
          return [];
        }
        twitter_user_ids = _.difference(
          twitter_user_ids,
          suspendedOrPotentiallyProblematicTwitterIds
        );
        if (twitter_user_ids.length === 0) {
          return [];
        }

        getTwitterUserInfoBulk(twitter_user_ids)
          .then(function (info: any[]) {
            const updateQueries = info.map(function (u: {
              id: any;
              screen_name: any;
              name: any;
              followers_count: any;
              friends_count: any;
              verified: any;
              profile_image_url_https: any;
              location: any;
            }) {
              const q =
                "update twitter_users set " +
                "screen_name = ($2)," +
                "name = ($3)," +
                "followers_count = ($4)," +
                "friends_count = ($5)," +
                "verified = ($6)," +
                "profile_image_url_https = ($7)," +
                "location = ($8)," +
                "modified = now_as_millis() " +
                "where twitter_user_id = ($1);";

              return pgQueryP(q, [
                u.id,
                u.screen_name,
                u.name,
                u.followers_count,
                u.friends_count,
                u.verified,
                u.profile_image_url_https,
                u.location,
              ]);
            });
            return Promise.all(updateQueries).then(function () {
              console.log("done123");
            });
          })
          .catch(function (err: any) {
            console.error(
              "error updating twitter users:" + twitter_user_ids.join(" ")
            );
          });
      })
  );
}


  // Ensure we don't call this more than 60 times in each 15 minute window (across all of our servers/use-cases)
  setInterval(updateSomeTwitterUsers, 1 * 60 * 1000);
  updateSomeTwitterUsers();

  function createUserFromTwitterInfo(o: any) {
    return createDummyUser().then(function (uid?: any) {
      return getAndInsertTwitterUser(o, uid).then(function (result: {
        twitterUser: any;
        twitterUserDbRecord: any;
      }) {
        const u = result.twitterUser;
        const twitterUserDbRecord = result.twitterUserDbRecord;

        return pgQueryP(
          "update users set hname = ($2) where uid = ($1) and hname is NULL;",
          [uid, u.name]
        ).then(function () {
          return twitterUserDbRecord;
        });
      });
    });
  }

  function prepForQuoteWithTwitterUser(
    quote_twitter_screen_name: any,
    zid: any
  ) {
    const query = pgQueryP(
      "select * from twitter_users where screen_name = ($1);",
      [quote_twitter_screen_name]
    );
    return addParticipantByTwitterUserId(
      query,
      {
        twitter_screen_name: quote_twitter_screen_name,
      },
      zid,
      null
    );
  }

  function prepForTwitterComment(twitter_tweet_id: any, zid: any) {
    return getTwitterTweetById(twitter_tweet_id).then(function (tweet: {
      user: any;
    }) {
      const user = tweet.user;
      const twitter_user_id = user.id_str;
      const query = pgQueryP(
        "select * from twitter_users where twitter_user_id = ($1);",
        [twitter_user_id]
      );
      return addParticipantByTwitterUserId(
        query,
        {
          twitter_user_id: twitter_user_id,
        },
        zid,
        tweet
      );
    });
  }

  function addParticipantByTwitterUserId(
    query: Promise<any>,
    o: { twitter_screen_name?: any; twitter_user_id?: any },
    zid: any,
    tweet: { user: any } | null
  ) {
    function addParticipantAndFinish(
      uid?: any,
      twitterUser?: any,
      tweet?: any
    ) {
      return (
        addParticipant(zid, uid)
          .then(function (rows: any[]) {
            const ptpt = rows[0];
            return {
              ptpt: ptpt,
              twitterUser: twitterUser,
              tweet: tweet,
            };
          })
      );
    }
    return query.then(function (rows: string | any[]) {
      if (rows && rows.length) {
        const twitterUser = rows[0];
        const uid = twitterUser.uid;
        return getParticipant(zid, uid)
          .then(function (ptpt: any) {
            if (!ptpt) {
              return addParticipantAndFinish(uid, twitterUser, tweet);
            }
            return {
              ptpt: ptpt,
              twitterUser: twitterUser,
              tweet: tweet,
            };
          })
          .catch(function (err: any) {
            return addParticipantAndFinish(uid, twitterUser, tweet);
          });
      } else {
        // no user records yet
        return createUserFromTwitterInfo(o).then(function (twitterUser: {
          uid?: any;
        }) {
          const uid = twitterUser.uid;
          return (
            addParticipant(zid, uid)
              .then(function (rows: any[]) {
                const ptpt = rows[0];
                return {
                  ptpt: ptpt,
                  twitterUser: twitterUser,
                  tweet: tweet,
                };
              })
          );
        });
      }
    });

    // * fetch tweet info
    //   if fails, return failure
    // * look for author in twitter_users
    //   if exists
    //    * use uid to find pid in participants
    //   if not exists
    //    * fetch info about user from twitter api
    //      if fails, ??????
    //      if ok
    //       * create a new user record
    //       * create a twitter record
  }




  function getAndInsertTwitterUser(o: any, uid?: any) {
    return getTwitterUserInfo(o, false).then(function (userString: string) {
      const u: UserType = JSON.parse(userString)[0];
      winston.log("info", "TWITTER USER INFO");
      winston.log("info", u);
      winston.log("info", "/TWITTER USER INFO");
      return (
        pgQueryP(
          "insert into twitter_users (" +
            "uid," +
            "twitter_user_id," +
            "screen_name," +
            "name," +
            "followers_count," +
            "friends_count," +
            "verified," +
            "profile_image_url_https," +
            "location," +
            "response" +
            ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *;",
          [
            uid,
            u.id,
            u.screen_name,
            u.name,
            u.followers_count,
            u.friends_count,
            u.verified,
            u.profile_image_url_https,
            u.location,
            JSON.stringify(u),
          ]
        )
          .then(function (rows: string | any[]) {
            const record = (rows && rows.length && rows[0]) || null;

            // return the twitter user record
            return {
              twitterUser: u,
              twitterUserDbRecord: record,
            };
          })
      );
    });
  }

  function handle_GET_twitter_oauth_callback(
    req: { p: { uid?: any; dest: any; oauth_verifier: any; oauth_token: any } },
    res: { redirect: (arg0: any) => void }
  ) {
    const uid = req.p.uid;
    winston.log("info", "twitter oauth callback req.p", req.p);

    // TODO "Upon a successful authentication, your callback_url would receive a request containing the oauth_token
    // and oauth_verifier parameters. Your application should verify that the token matches the request token received
    // in step 1."

    const dest = req.p.dest;
    winston.log("info", "twitter_oauth_callback uid", uid);
    winston.log("info", "twitter_oauth_callback params");
    winston.log("info", req.p);
    winston.log("info", "twitter_oauth_callback params end");
    // this api sometimes succeeds, and sometimes fails, not sure why
    function tryGettingTwitterAccessToken() {
      return getTwitterAccessToken({
        oauth_verifier: req.p.oauth_verifier,
        oauth_token: req.p.oauth_token,
        // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the
        // header, but this will have been added by the signing process."
      });
    }
    retryFunctionWithPromise(tryGettingTwitterAccessToken, 20)
      .then(
        function (o: string) {
          winston.log("info", "TWITTER ACCESS TOKEN");
          const pairs = o.split("&");
          const kv: TwitterParameters = {};
          pairs.forEach(function (pair: string) {
            const pairSplit = pair.split("=");
            const k = pairSplit[0];
            const v = pairSplit[1];
            kv[k] = v;
          });
          winston.log("info", kv);
          winston.log("info", "/TWITTER ACCESS TOKEN");

          // TODO - if no auth, generate a new user.

          getTwitterUserInfo(
            {
              twitter_user_id: kv.user_id,
            },
            false
          )
            .then(
              function (userStringPayload: string) {
                const u: UserType = JSON.parse(userStringPayload)[0];
                winston.log("info", "TWITTER USER INFO");
                winston.log("info", u);
                winston.log("info", "/TWITTER USER INFO");
                return pgQueryP(
                  "insert into twitter_users (" +
                    "uid," +
                    "twitter_user_id," +
                    "screen_name," +
                    "name," +
                    "followers_count," +
                    "friends_count," +
                    "verified," +
                    "profile_image_url_https," +
                    "location," +
                    "response" +
                    ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);",
                  [
                    uid,
                    u.id,
                    u.screen_name,
                    u.name,
                    u.followers_count,
                    u.friends_count,
                    u.verified,
                    u.profile_image_url_https,
                    u.location,
                    JSON.stringify(u),
                  ]
                ).then(
                  function () {
                    // SUCCESS
                    // There was no existing record
                    // set the user's hname, if not already set
                    pgQueryP(
                      "update users set hname = ($2) where uid = ($1) and hname is NULL;",
                      [uid, u.name]
                    )
                      .then(
                        function () {
                          // OK, ready
                          u.uid = uid;
                          res.redirect(dest);
                        },
                        function (err: any) {
                          fail(res, 500, "polis_err_twitter_auth_update", err);
                        }
                      )
                      .catch(function (err: any) {
                        fail(
                          res,
                          500,
                          "polis_err_twitter_auth_update_misc",
                          err
                        );
                      });
                  },
                  function (err: any) {
                    if (isDuplicateKey(err)) {
                      // we know the uid OR twitter_user_id is filled
                      // check if the uid is there with the same twitter_user_id - if so, redirect and good!
                      // determine which kind of duplicate
                      Promise.all([
                        pgQueryP(
                          "select * from twitter_users where uid = ($1);",
                          [uid]
                        ),
                        pgQueryP(
                          "select * from twitter_users where twitter_user_id = ($1);",
                          [u.id]
                        ),
                      ])
                        .then(function (foo: any[][]) {
                          const recordForUid = foo[0][0];
                          const recordForTwitterId = foo[1][0];
                          if (recordForUid && recordForTwitterId) {
                            if (recordForUid.uid === recordForTwitterId.uid) {
                              // match
                              res.redirect(dest);
                            } else {
                              // TODO_SECURITY_REVIEW
                              // both exist, but not same uid
                              switchToUser(req, res, recordForTwitterId.uid)
                                .then(function () {
                                  res.redirect(dest);
                                })
                                .catch(function (err: any) {
                                  fail(
                                    res,
                                    500,
                                    "polis_err_twitter_auth_456",
                                    err
                                  );
                                });
                            }
                          } else if (recordForUid) {
                            // currently signed in user has a twitter account attached, but it's a different twitter
                            // account, and they are now signing in with a different twitter account.
                            // the newly supplied twitter account is not attached to anything.
                            fail(
                              res,
                              500,
                              "polis_err_twitter_already_attached",
                              err
                            );
                          } else if (recordForTwitterId) {
                            // currently signed in user has no twitter account attached, but they just signed in with a
                            // twitter account which is attached to another user.
                            // For now, let's just have it sign in as that user.
                            // TODO_SECURITY_REVIEW
                            switchToUser(req, res, recordForTwitterId.uid)
                              .then(function () {
                                res.redirect(dest);
                              })
                              .catch(function (err: any) {
                                fail(
                                  res,
                                  500,
                                  "polis_err_twitter_auth_234",
                                  err
                                );
                              });
                          } else {
                            fail(res, 500, "polis_err_twitter_auth_345");
                          }
                        });

                      // else check if the uid is there and has some other screen_name - if so, ????????

                      // else check if the screen_name is there, but for a different uid - if so, ??????
                    } else {
                      fail(res, 500, "polis_err_twitter_auth_05", err);
                    }
                  }
                );
              },
              function (err: any) {
                winston.log("error", "failed to getTwitterUserInfo");
                fail(res, 500, "polis_err_twitter_auth_041", err);
              }
            )
            .catch(function (err: any) {
              fail(res, 500, "polis_err_twitter_auth_04", err);
            });
        },
        function (err: any) {
          fail(res, 500, "polis_err_twitter_auth_gettoken", err);
        }
      )
      .catch(function (err: any) {
        fail(res, 500, "polis_err_twitter_auth_misc", err);
      });
  }