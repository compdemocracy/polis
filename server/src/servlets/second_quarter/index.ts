
function addExtendedParticipantInfo(zid: any, uid?: any, data?: {}) {
  if (!data || !_.keys(data).length) {
    return Promise.resolve();
  }

  const params = Object.assign({}, data, {
    zid: zid,
    uid: uid,
    modified: 9876543212345, // hacky string, will be replaced with the word "default".
  });
  const qUpdate = sql_participants_extended
    .update(params)
    .where(sql_participants_extended.zid.equals(zid))
    .and(sql_participants_extended.uid.equals(uid));
  let qString = qUpdate.toString();
  qString = qString.replace("9876543212345", "now_as_millis()");
  return pgQueryP(qString, []);
}

function tryToJoinConversation(
  zid: any,
  uid?: any,
  info?: any,
  pmaid_answers?: string | any[]
) {
  console.log("tryToJoinConversation");
  console.dir(arguments);

  function doAddExtendedParticipantInfo() {
    if (info && _.keys(info).length > 0) {
      addExtendedParticipantInfo(zid, uid, info);
    }
  }

  function saveMetadataChoices(pid?: number) {
    if (pmaid_answers && pmaid_answers.length) {
      saveParticipantMetadataChoicesP(zid, pid, pmaid_answers);
    }
  }

  // there was no participant row, so create one
  return addParticipant(zid, uid).then(function (rows: any[]) {
    const pid = rows && rows[0] && rows[0].pid;
    const ptpt = rows[0];

    doAddExtendedParticipantInfo();

    if (pmaid_answers && pmaid_answers.length) {
      saveMetadataChoices();
    }
    populateParticipantLocationRecordIfPossible(zid, uid, pid);
    return ptpt;
  });
}

function addParticipantAndMetadata(
  zid: any,
  uid?: any,
  req?: {
    cookies: { [x: string]: any };
    p: { parent_url: any };
    headers?: { [x: string]: any };
  },
  permanent_cookie?: any
) {
  const info: { [key: string]: string } = {};
  const parent_url = req?.cookies?.[COOKIES.PARENT_URL] || req?.p?.parent_url;
  const referer =
    req?.cookies[COOKIES.PARENT_REFERRER] ||
    req?.headers?.["referer"] ||
    req?.headers?.["referrer"];
  if (parent_url) {
    info.parent_url = parent_url;
  }
  console.log("mike foo");
  if (referer) {
    info.referrer = referer;
  }
  const x_forwarded_for = req?.headers?.["x-forwarded-for"];
  let ip: string | null = null;
  if (x_forwarded_for) {
    let ips = x_forwarded_for;
    ips = ips && ips.split(", ");
    ip = ips.length && ips[0];
    info.encrypted_ip_address = encrypt(ip);
    info.encrypted_x_forwarded_for = encrypt(x_forwarded_for);
    console.log("mike encrypt");
  }
  if (permanent_cookie) {
    info.permanent_cookie = permanent_cookie;
  }
  if (req?.headers?.["origin"]) {
    info.origin = req?.headers?.["origin"];
  }

  return addParticipant(zid, uid).then((rows: any[]) => {
    const ptpt = rows[0];
    const pid = ptpt.pid;
    populateParticipantLocationRecordIfPossible(zid, uid, pid);
    addExtendedParticipantInfo(zid, uid, info);
    if (ip) {
      populateGeoIpInfo(zid, uid, ip);
    }
    return rows;
  });
}

function joinConversation(
  zid: any,
  uid?: any,
  info?: {},
  pmaid_answers?: any
) {
  function tryJoin() {
    return tryToJoinConversation(zid, uid, info, pmaid_answers);
  }

  function doJoin() {
    // retry up to 10 times
    // NOTE: Shouldn't be needed, since we have an advisory lock in the insert trigger.
    //       However, that doesn't seem to be preventing duplicate pid constraint errors.
    //       Doing this retry in JS for now since it's quick and easy, rather than try to
    //       figure what's wrong with the postgres locks.
    const promise = tryJoin()
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin);
    return promise;
  }

  return getPidPromise(zid, uid).then(function (pid: number) {
    if (pid >= 0) {
      // already a ptpt, so don't create another
      return;
    } else {
      return doJoin();
    }
  }, doJoin);
}

function isOwnerOrParticipant(
  zid: any,
  uid?: any,
  callback?: { (): void; (arg0: null): void }
) {
  // TODO should be parallel.
  // look into bluebird, use 'some' https://github.com/petkaantonov/bluebird
  getPid(zid, uid, function (err: any, pid: number) {
    if (err || pid < 0) {
      isConversationOwner(zid, uid, function (err: any) {
        callback?.(err);
      });
    } else {
      callback?.(null);
    }
  });
}

function isConversationOwner(
  zid: any,
  uid?: any,
  callback?: {
    (err: any): void;
    (err: any): void;
    (err: any): void;
    (err: any, foo: any): void;
    (err: any, foo: any): void;
    (arg0: any): void;
  }
) {
  pgQuery_readOnly(
    "SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);",
    [zid, uid],
    function (err: number, docs: { rows: string | any[] }) {
      if (!docs || !docs.rows || docs.rows.length === 0) {
        err = err || 1;
      }
      callback?.(err);
    }
  );
}

function isOwner(zid: any, uid: string) {
  return getConversationInfo(zid).then(function (info: { owner: any }) {
    winston.log("info", 39847534987 + " isOwner " + uid);
    winston.log("info", info);
    winston.log("info", info.owner === uid);
    return info.owner === uid;
  });
}

function isModerator(zid: any, uid?: any) {
  if (isPolisDev(uid)) {
    return Promise.resolve(true);
  }
  return pgQueryP_readOnly(
    "select count(*) from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($2))) and zid = ($1);",
    [zid, uid]
  ).then(function (rows: { count: number }[]) {
    return rows[0].count >= 1;
  });
}

// returns null if it's missing
function getParticipant(zid: any, uid?: any) {
  return new MPromise(
    "getParticipant",
    function (resolve: (arg0: any) => void, reject: (arg0: Error) => any) {
      pgQuery_readOnly(
        "SELECT * FROM participants WHERE zid = ($1) AND uid = ($2);",
        [zid, uid],
        function (err: any, results: { rows: any[] }) {
          if (err) {
            return reject(err);
          }
          if (!results || !results.rows) {
            return reject(new Error("polis_err_getParticipant_failed"));
          }
          resolve(results.rows[0]);
        }
      );
    }
  );
}

function getAnswersForConversation(
  zid: any,
  callback: {
    (err: any, available_answers: any): any;
    (arg0: number, arg1?: undefined): void;
  }
) {
  pgQuery_readOnly(
    "SELECT * from participant_metadata_answers WHERE zid = ($1) AND alive=TRUE;",
    [zid],
    function (err: any, x: { rows: any }) {
      if (err) {
        callback(err);
        return;
      }
      callback(0, x.rows);
    }
  );
}

function getChoicesForConversation(zid: any) {
  return new Promise(function (
    resolve: (arg0: never[]) => void,
    reject: (arg0: any) => void
  ) {
    pgQuery_readOnly(
      "select * from participant_metadata_choices where zid = ($1) and alive = TRUE;",
      [zid],
      function (err: any, x: { rows: any }) {
        if (err) {
          reject(err);
          return;
        }
        if (!x || !x.rows) {
          resolve([]);
          return;
        }
        resolve(x.rows);
      }
    );
  });
}

const getUserInfoForUid = User.getUserInfoForUid;
const getUserInfoForUid2 = User.getUserInfoForUid2;

// Email.emailFeatureRequest;

// Email.sendPasswordResetEmail;

function sendMultipleTextEmails(
  sender: string | undefined,
  recipientArray: any[],
  subject: string,
  text: string
) {
  recipientArray = recipientArray || [];
  return Promise.all(
    recipientArray.map(function (email: string) {
      const promise = sendTextEmail(sender, email, subject, text);
      promise.catch(function (err: any) {
        yell("polis_err_failed_to_email_for_user " + email);
      });
      return promise;
    })
  );
}

// Email.trySendingBackupEmailTest;

// Email.sendEinivteEmail;

function isEmailVerified(email: any) {
  return (
    dbPgQuery
      .queryP("select * from email_validations where email = ($1);", [email])
      .then(function (rows: string | any[]) {
        return rows.length > 0;
      })
  );
}

// Email.handle_GET_verification;

function paramsToStringSortedByName(params: {
  conversation_id?: any;
  email?: any;
}) {
  const pairs = _.pairs(params).sort(function (a: number[], b: number[]) {
    return a[0] > b[0];
  });
  const pairsList = pairs.map(function (pair: any[]) {
    return pair.join("=");
  });
  return pairsList.join("&");
}

const HMAC_SIGNATURE_PARAM_NAME = "signature";

function createHmacForQueryParams(
  path: string,
  params: { conversation_id?: any; email?: any }
) {
  path = path.replace(/\/$/, ""); // trim trailing "/"
  const s = path + "?" + paramsToStringSortedByName(params);
  const hmac = crypto.createHmac(
    "sha1",
    "G7f387ylIll8yuskuf2373rNBmcxqWYFfHhdsd78f3uekfs77EOLR8wofw"
  );
  hmac.setEncoding("hex");
  hmac.write(s);
  hmac.end();
  const hash = hmac.read();
  return hash;
}

function verifyHmacForQueryParams(
  path: string,
  params: { [x: string]: any; conversation_id?: any; email?: any }
) {
  return new Promise(function (resolve: () => void, reject: () => void) {
    params = _.clone(params);
    const hash = params[HMAC_SIGNATURE_PARAM_NAME];
    delete params[HMAC_SIGNATURE_PARAM_NAME];
    const correctHash = createHmacForQueryParams(path, params);
    // To thwart timing attacks, add some randomness to the response time with setTimeout.
    setTimeout(function () {
      winston.log("info", "comparing", correctHash, hash);
      if (correctHash === hash) {
        resolve();
      } else {
        reject();
      }
    });
  });
}

function sendEmailByUid(uid?: any, subject?: string, body?: string | number) {
  return getUserInfoForUid2(uid).then(function (userInfo: {
    hname: any;
    email: any;
  }) {
    return sendTextEmail(
      polisFromAddress,
      userInfo.hname
        ? `${userInfo.hname} <${userInfo.email}>`
        : userInfo.email,
      subject,
      body
    );
  });
}

function handle_GET_participants(
  req: { p: { uid?: any; zid: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;

  pgQueryP_readOnly(
    "select * from participants where uid = ($1) and zid = ($2)",
    [uid, zid]
  )
    .then(function (rows: string | any[]) {
      const ptpt = (rows && rows.length && rows[0]) || null;
      res.status(200).json(ptpt);
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_get_participant", err);
    });
}
function handle_GET_dummyButton(
  req: { p: { button: string; uid: string } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; end: { (): void; new (): any } };
  }
) {
  const message = req.p.button + " " + req.p.uid;
  emailFeatureRequest(message);
  res.status(200).end();
}
function doGetConversationsRecent(
  req: { p: { uid?: any; sinceUnixTimestamp: any } },
  res: { json: (arg0: any) => void },
  field: string
) {
  if (!isPolisDev(req.p.uid)) {
    fail(res, 403, "polis_err_no_access_for_this_user");
    return;
  }
  let time = req.p.sinceUnixTimestamp;
  if (_.isUndefined(time)) {
    time = Date.now() - 1000 * 60 * 60 * 24 * 7;
  } else {
    time *= 1000;
  }
  time = parseInt(time);
  pgQueryP_readOnly(
    "select * from conversations where " + field + " >= ($1);",
    [time]
  )
    .then((rows: any) => {
      res.json(rows);
    })
    .catch((err: any) => {
      fail(res, 403, "polis_err_conversationsRecent", err);
    });
}

function handle_GET_conversationsRecentlyStarted(req: any, res: any) {
  doGetConversationsRecent(req, res, "created");
}

function handle_GET_conversationsRecentActivity(req: any, res: any) {
  doGetConversationsRecent(req, res, "modified");
}

function userHasAnsweredZeQuestions(zid: any, answers: string | any[]) {
  return new MPromise(
    "userHasAnsweredZeQuestions",
    function (resolve: () => any, reject: (arg0: Error) => void) {
      getAnswersForConversation(
        zid,
        function (err: any, available_answers: any) {
          if (err) {
            reject(err);
            return;
          }

          const q2a = _.indexBy(available_answers, "pmqid");
          const a2q = _.indexBy(available_answers, "pmaid");
          for (let i = 0; i < answers.length; i++) {
            const pmqid = a2q[answers[i]].pmqid;
            delete q2a[pmqid];
          }
          const remainingKeys = _.keys(q2a);
          const missing = remainingKeys && remainingKeys.length > 0;
          if (missing) {
            return reject(
              new Error(
                "polis_err_metadata_not_chosen_pmqid_" + remainingKeys[0]
              )
            );
          } else {
            return resolve();
          }
        }
      );
    }
  );
}
function handle_POST_participants(
  req: {
    p: { zid: any; uid?: any; answers: any; parent_url: any; referrer: any };
    cookies: { [x: string]: any };
  },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const answers = req.p.answers;
  const info: ParticipantInfo = {};

  const parent_url = req.cookies[COOKIES.PARENT_URL] || req.p.parent_url;
  const referrer = req.cookies[COOKIES.PARENT_REFERRER] || req.p.referrer;

  if (parent_url) {
    info.parent_url = parent_url;
  }
  if (referrer) {
    info.referrer = referrer;
  }

  function finish(ptpt: any) {
    clearCookie(req, res, COOKIES.PARENT_URL);
    clearCookie(req, res, COOKIES.PARENT_REFERRER);

    setTimeout(function () {
      updateLastInteractionTimeForConversation(zid, uid);
    }, 0);
    res.status(200).json(ptpt);
  }

  function doJoin() {
    userHasAnsweredZeQuestions(zid, answers).then(
      function () {
        joinConversation(zid, uid, info, answers).then(
          function (ptpt: any) {
            finish(ptpt);
          },
          function (err: any) {
            fail(res, 500, "polis_err_add_participant", err);
          }
        );
      },
      function (err: { message: any }) {
        userFail(res, 400, err.message, err);
      }
    );
  }

  // Check if already in the conversation
  getParticipant(zid, req.p.uid)
    .then(
      function (ptpt: { pid: any }) {
        if (ptpt) {
          finish(ptpt);

          // populate their location if needed - no need to wait on this.
          populateParticipantLocationRecordIfPossible(
            zid,
            req.p.uid,
            ptpt.pid
          );
          addExtendedParticipantInfo(zid, req.p.uid, info);
          return;
        }

        getConversationInfo(zid)
          .then(function (conv: { lti_users_only: any }) {
            if (conv.lti_users_only) {
              if (uid) {
                pgQueryP("select * from lti_users where uid = ($1)", [uid])
                  .then(function (rows: string | any[]) {
                    if (rows && rows.length) {
                      // found a record in lti_users
                      doJoin();
                    } else {
                      userFail(
                        res,
                        403,
                        "polis_err_post_participants_missing_lti_user_for_uid_1"
                      );
                    }
                  })
                  .catch(function (err: any) {
                    fail(
                      res,
                      500,
                      "polis_err_post_participants_missing_lti_user_for_uid_2",
                      err
                    );
                  });
              } else {
                userFail(
                  res,
                  403,
                  "polis_err_post_participants_need_uid_to_check_lti_users_3"
                );
              }
            } else {
              // no LTI stuff to worry about
              doJoin();
            }
          })
          .catch(function (err: any) {
            fail(
              res,
              500,
              "polis_err_post_participants_need_uid_to_check_lti_users_4",
              err
            );
          });
      },
      function (err: any) {
        fail(res, 500, "polis_err_post_participants_db_err", err);
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_post_participants_misc", err);
    });
}

const addLtiUserIfNeeded = User.addLtiUserIfNeeded;
const addLtiContextMembership = User.addLtiContextMembership;

function subscribeToNotifications(zid: any, uid?: any, email?: any) {
  const type = 1; // 1 for email
  winston.log("info", "subscribeToNotifications", zid, uid);
  return pgQueryP(
    "update participants_extended set subscribe_email = ($3) where zid = ($1) and uid = ($2);",
    [zid, uid, email]
  ).then(function () {
    return pgQueryP(
      "update participants set subscribed = ($3) where zid = ($1) and uid = ($2);",
      [zid, uid, type]
    ).then(function (rows: any) {
      return type;
    });
  });
}

function unsubscribeFromNotifications(zid: any, uid?: any) {
  const type = 0; // 1 for nothing
  return pgQueryP(
    "update participants set subscribed = ($3) where zid = ($1) and uid = ($2);",
    [zid, uid, type]
  ).then(function (rows: any) {
    return type;
  });
}

function addNotificationTask(zid: any) {
  return pgQueryP(
    "insert into notification_tasks (zid) values ($1) on conflict (zid) do update set modified = now_as_millis();",
    [zid]
  );
}

function maybeAddNotificationTask(zid: any, timeInMillis: any) {
  return pgQueryP(
    "insert into notification_tasks (zid, modified) values ($1, $2) on conflict (zid) do nothing;",
    [zid, timeInMillis]
  );
}

function claimNextNotificationTask() {
  return pgQueryP(
    "delete from notification_tasks where zid = (select zid from notification_tasks order by random() for update skip locked limit 1) returning *;"
  ).then((rows: string | any[]) => {
    if (!rows || !rows.length) {
      return null;
    }
    return rows[0];
  });
}

function getDbTime() {
  return pgQueryP("select now_as_millis();", []).then(
    (rows: { now_as_millis: any }[]) => {
      return rows[0].now_as_millis;
    }
  );
}

function doNotificationsForZid(zid: any, timeOfLastEvent: any) {
  let shouldTryAgain = false;

  return (
    pgQueryP(
      "select * from participants where zid = ($1) and last_notified < ($2) and subscribed > 0;",
      [zid, timeOfLastEvent]
    )
      .then((candidates: any[]) => {
        if (!candidates || !candidates.length) {
          return null;
        }
        candidates = candidates.map(
          (ptpt: { last_notified: number; last_interaction: number }) => {
            ptpt.last_notified = Number(ptpt.last_notified);
            ptpt.last_interaction = Number(ptpt.last_interaction);
            return ptpt;
          }
        );
        return Promise.all([
          getDbTime(),
          getConversationInfo(zid),
          getZinvite(zid),
        ]).then((a: any[]) => {
          const dbTimeMillis = a[0];
          const conv = a[1];
          const conversation_id = a[2];

          const url = conv.parent_url || "https://pol.is/" + conversation_id;

          const pid_to_ptpt = {};
          candidates.forEach((c: { pid: string | number }) => {
            pid_to_ptpt[c.pid] = c;
          });
          return Promise.mapSeries(
            candidates,
            (item: { zid: any; pid: any }, index: any, length: any) => {
              return getNumberOfCommentsRemaining(item.zid, item.pid).then(
                (rows: any[]) => {
                  return rows[0];
                }
              );
            }
          ).then((results: any[]) => {
            const needNotification = results.filter(
              (result: { pid: string | number; remaining: number }) => {
                const ptpt = pid_to_ptpt[result.pid];
                let needs = true;

                needs = needs && result.remaining > 0;

                let waitTime = 60 * 60 * 1000;

                // notifications since last interation
                if (ptpt.nsli === 0) {
                  // first notification since last interaction
                  waitTime = 60 * 60 * 1000; // 1 hour
                } else if (ptpt.nsli === 1) {
                  // second notification since last interaction
                  waitTime = 2 * 60 * 60 * 1000; // 4 hours
                } else if (ptpt.nsli === 2) {
                  // third notification since last interaction
                  waitTime = 24 * 60 * 60 * 1000; // 24 hours
                } else if (ptpt.nsli === 3) {
                  // third notification since last interaction
                  waitTime = 48 * 60 * 60 * 1000; // 48 hours
                } else {
                  // give up, if they vote again nsli will be set to zero again.
                  console.log("doNotificationsForZid", "nsli");
                  needs = false;
                }

                if (needs && dbTimeMillis < ptpt.last_notified + waitTime) {
                  // Limit to one per hour.
                  console.log(
                    "doNotificationsForZid",
                    "shouldTryAgain",
                    "last_notified"
                  );
                  shouldTryAgain = true;
                  needs = false;
                }
                if (
                  needs &&
                  dbTimeMillis < ptpt.last_interaction + 5 * 60 * 1000
                ) {
                  // Wait until 5 minutes after their last interaction.
                  console.log(
                    "doNotificationsForZid",
                    "shouldTryAgain",
                    "last_interaction"
                  );
                  shouldTryAgain = true;
                  needs = false;
                }

                if (devMode) {
                  needs = needs && isPolisDev(ptpt.uid);
                }
                return needs;
              }
            );

            if (needNotification.length === 0) {
              return null;
            }
            const pids = _.pluck(needNotification, "pid");

            return pgQueryP(
              "select uid, subscribe_email from participants_extended where uid in (select uid from participants where pid in (" +
                pids.join(",") +
                "));",
              []
            ).then((rows: any[]) => {
              const uidToEmail = {};
              rows.forEach(
                (row: { uid: string | number; subscribe_email: any }) => {
                  uidToEmail[row.uid] = row.subscribe_email;
                }
              );

              return Promise.each(
                needNotification,
                (
                  item: { pid: string | number; remaining: any },
                  index: any,
                  length: any
                ) => {
                  const uid = pid_to_ptpt[item.pid].uid;
                  return sendNotificationEmail(
                    uid,
                    url,
                    conversation_id,
                    uidToEmail[uid],
                    item.remaining
                  ).then(() => {
                    return pgQueryP(
                      "update participants set last_notified = now_as_millis(), nsli = nsli + 1 where uid = ($1) and zid = ($2);",
                      [uid, zid]
                    );
                  });
                }
              );
            });
          });
        });
      })
      .then(() => {
        return shouldTryAgain;
      })
  );
}
function doNotificationBatch() {
  return claimNextNotificationTask().then(
    (task: { zid: any; modified: any }) => {
      if (!task) {
        return Promise.resolve();
      }
      console.log("doNotificationsForZid", task.zid);
      return doNotificationsForZid(task.zid, task.modified).then(
        (shouldTryAgain: any) => {
          console.log(
            "doNotificationsForZid",
            task.zid,
            "shouldTryAgain",
            shouldTryAgain
          );
          if (shouldTryAgain) {
            // Since we claimed the task above, there will be no record, so we need to
            // put it back to trigger a retry - unless there's a new one there, in which case we should
            // leave the new one.
            maybeAddNotificationTask(task.zid, task.modified);
          }
        }
      );
    }
  );
}

function doNotificationLoop() {
  console.log("doNotificationLoop");
  doNotificationBatch().then(() => {
    setTimeout(doNotificationLoop, 10000);
  });
}

function sendNotificationEmail(
  uid?: any,
  url?: string,
  conversation_id?: string,
  email?: any,
  remaining?: any
) {
  const subject =
  // Not sure if putting the conversation_id is ideal, but we need some way to ensure that the notifications for each
  // conversation appear in separte threads.
    "New statements to vote on (conversation " + conversation_id + ")";
  let body = "There are new statements available for you to vote on here:\n";
  body += "\n";
  body += url + "\n";
  body += "\n";
  body +=
    "You're receiving this message because you're signed up to receive Polis notifications for this conversation. You can unsubscribe from these emails by clicking this link:\n";
  body += createNotificationsUnsubscribeUrl(conversation_id, email) + "\n";
  body += "\n";
  body +=
    "If for some reason the above link does not work, please reply directly to this email with the message 'Unsubscribe' and we will remove you within 24 hours.";
  body += "\n";
  body += "Thanks for your participation";
  return sendEmailByUid(uid, subject, body);
}

const shouldSendNotifications = !devMode;
if (shouldSendNotifications) {
  doNotificationLoop();
}

function createNotificationsUnsubscribeUrl(conversation_id: any, email: any) {
  const params = {
    conversation_id: conversation_id,
    email: email,
  };
  const path = "api/v3/notifications/unsubscribe";

  params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

  const server = Config.getServerUrl();
  return server + "/" + path + "?" + paramsToStringSortedByName(params);
}

function createNotificationsSubscribeUrl(conversation_id: any, email: any) {
  const params = {
    conversation_id: conversation_id,
    email: email,
  };
  const path = "api/v3/notifications/subscribe";

  params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

  const server = Config.getServerUrl();
  return server + "/" + path + "?" + paramsToStringSortedByName(params);
}

// Email.handleGetNotificationsSubscribe;

// Email.handleGetNotificationsUnsubscribe;

function handle_POST_convSubscriptions(
  req: { p: { zid: any; uid?: any; type: any; email: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: { subscribed: any }): void; new (): any };
    };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const type = req.p.type;

  const email = req.p.email;

  function finish(type: any) {
    res.status(200).json({
      subscribed: type,
    });
  }

  if (type === 1) {
    subscribeToNotifications(zid, uid, email)
      .then(finish)
      .catch(function (err: any) {
        fail(res, 500, "polis_err_sub_conv " + zid + " " + uid, err);
      });
  } else if (type === 0) {
    unsubscribeFromNotifications(zid, uid)
      .then(finish)
      .catch(function (err: any) {
        fail(res, 500, "polis_err_unsub_conv " + zid + " " + uid, err);
      });
  } else {
    fail(
      res,
      400,
      "polis_err_bad_subscription_type",
      new Error("polis_err_bad_subscription_type")
    );
  }
}

function handle_POST_auth_login(
  req: {
    p: {
      password: any;
      email: string;
      lti_user_id: any;
      lti_user_image: any;
      lti_context_id: any;
      tool_consumer_instance_guid?: any;
      afterJoinRedirectUrl: any;
    };
  },
  res: {
    redirect: (arg0: any) => void;
    json: (arg0: { uid?: any; email: any; token: any }) => void;
  }
) {
  const password = req.p.password;
  let email = req.p.email || "";
  const lti_user_id = req.p.lti_user_id;
  const lti_user_image = req.p.lti_user_image;
  const lti_context_id = req.p.lti_context_id;
  const tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
  const afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

  email = email.toLowerCase();
  if (!_.isString(password) || !password.length) {
    fail(res, 403, "polis_err_login_need_password");
    return;
  }
  pgQuery(
    "SELECT * FROM users WHERE LOWER(email) = ($1);",
    [email],
    function (err: any, docs: { rows?: any[] }) {
      const { rows } = docs;
      if (err) {
        fail(res, 403, "polis_err_login_unknown_user_or_password", err);
        console.error("polis_err_login_unknown_user_or_password_err");
        return;
      }
      if (!rows || rows.length === 0) {
        fail(res, 403, "polis_err_login_unknown_user_or_password_noresults");
        console.error("polis_err_login_unknown_user_or_password_noresults");
        return;
      }

      const uid = rows[0].uid;

      pgQuery(
        "select pwhash from jianiuevyew where uid = ($1);",
        [uid],
        function (err: any, results: { rows: any[] }) {
          const { rows } = results;
          if (err) {
            fail(res, 403, "polis_err_login_unknown_user_or_password", err);
            console.error("polis_err_login_unknown_user_or_password_err");
            return;
          }
          if (!results || rows.length === 0) {
            fail(res, 403, "polis_err_login_unknown_user_or_password");
            console.error(
              "polis_err_login_unknown_user_or_password_noresults"
            );
            return;
          }

          const hashedPassword = rows[0].pwhash;

          bcrypt.compare(
            password,
            hashedPassword,
            function (errCompare: any, result: any) {
              winston.log("info", "errCompare, result", errCompare, result);
              if (errCompare || !result) {
                fail(res, 403, "polis_err_login_unknown_user_or_password");
                console.error(
                  "polis_err_login_unknown_user_or_password_badpassword"
                );
                return;
              }

              startSession(uid, function (errSess: any, token: any) {
                const response_data = {
                  uid: uid,
                  email: email,
                  token: token,
                };

                addCookies(req, res, token, uid)
                  .then(function () {
                    winston.log("info", "uid", uid);
                    winston.log("info", "lti_user_id", lti_user_id);
                    winston.log("info", "lti_context_id", lti_context_id);
                    const ltiUserPromise = lti_user_id
                      ? addLtiUserIfNeeded(
                          uid,
                          lti_user_id,
                          tool_consumer_instance_guid,
                          lti_user_image
                        )
                      : Promise.resolve();
                    const ltiContextMembershipPromise = lti_context_id
                      ? addLtiContextMembership(
                          uid,
                          lti_context_id,
                          tool_consumer_instance_guid
                        )
                      : Promise.resolve();
                    Promise.all([ltiUserPromise, ltiContextMembershipPromise])
                      .then(function () {
                        if (lti_user_id) {
                          if (afterJoinRedirectUrl) {
                            res.redirect(afterJoinRedirectUrl);
                          } else {
                            User.renderLtiLinkageSuccessPage(req, res, {
                              // may include token here too
                              context_id: lti_context_id,
                              uid: uid,
                              // hname: hname,
                              email: email,
                            });
                          }
                        } else {
                          res.json(response_data);
                        }
                      })
                      .catch(function (err: any) {
                        fail(
                          res,
                          500,
                          "polis_err_adding_associating_with_lti_user",
                          err
                        );
                      });
                  })
                  .catch(function (err: any) {
                    fail(res, 500, "polis_err_adding_cookies", err);
                  });
              }); // startSession
            }
          ); // compare
        }
      ); // pwhash query
    }
  ); // users query
} // /api/v3/auth/login

function handle_POST_joinWithInvite(
  req: {
    p: {
      answers: any;
      uid?: any;
      suzinvite: any;
      permanentCookieToken: any;
      zid: any;
      referrer: any;
      parent_url: any;
    };
  },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: { pid: any; uid?: any }): void; new (): any };
    };
  }
) {
  // if they're already in the conv
  //     this shouldn't get called
  // else
  //     not in conv.
  //     need to join
  //     has their permanentCookieToken already joined?
  //         do they have an email attached?
  //              hmm weird.. what to do?
  //         else
  //              force them to create a full account
  //     else
  //         let them join without forcing a sign in (assuming conversation allows that)

  return (
    joinWithZidOrSuzinvite({
      answers: req.p.answers,
      existingAuth: !!req.p.uid,
      suzinvite: req.p.suzinvite,
      permanentCookieToken: req.p.permanentCookieToken,
      uid: req.p.uid,
      zid: req.p.zid, // since the zid is looked up using the conversation_id, it's safe to use zid as an invite token. TODO huh?
      referrer: req.p.referrer,
      parent_url: req.p.parent_url,
    })
      .then(function (o: { uid?: any; existingAuth: string }) {
        const uid = o.uid;
        winston.log(
          "info",
          "startSessionAndAddCookies " + uid + " existing " + o.existingAuth
        );
        // TODO check for possible security implications
        if (!o.existingAuth) {
          return startSessionAndAddCookies(req, res, uid).then(function () {
            return o;
          });
        }
        return Promise.resolve(o);
      })
      .then(function (o: { permanentCookieToken: any; zid: any }) {
        winston.log("info", "permanentCookieToken", o.permanentCookieToken);
        if (o.permanentCookieToken) {
          return recordPermanentCookieZidJoin(
            o.permanentCookieToken,
            o.zid
          ).then(
            function () {
              return o;
            },
            function () {
              return o;
            }
          );
        } else {
          return o;
        }
      })
      .then(function (o: { pid: any }) {
        const pid = o.pid;
        res.status(200).json({
          pid: pid,
          uid: req.p.uid,
        });
      })
      .catch(function (err: { message: string }) {
        if (
          err &&
          err.message &&
          err.message.match(/polis_err_need_full_user/)
        ) {
          userFail(res, 403, err.message, err);
        } else if (err && err.message) {
          fail(res, 500, err.message, err);
        } else if (err) {
          fail(res, 500, "polis_err_joinWithZidOrSuzinvite", err);
        } else {
          fail(res, 500, "polis_err_joinWithZidOrSuzinvite");
        }
      })
  );
}

function joinWithZidOrSuzinvite(o: {
  answers: any;
  existingAuth: boolean;
  suzinvite: any;
  permanentCookieToken: any;
  uid?: any;
  zid: any; // since the zid is looked up using the conversation_id, it's safe to use zid as an invite token. TODO huh?
  referrer: any;
  parent_url: any;
}) {
  return (
    Promise.resolve(o)
      .then(function (o: { suzinvite: any; zid: any }) {
        if (o.suzinvite) {
          return getSUZinviteInfo(o.suzinvite).then(function (
            suzinviteInfo: any
          ) {
            return Object.assign(o, suzinviteInfo);
          });
        } else if (o.zid) {
          return o;
        } else {
          throw new Error("polis_err_missing_invite");
        }
      })
      .then(function (o: { zid: any; conv: any }) {
        winston.log("info", "joinWithZidOrSuzinvite convinfo begin");
        return getConversationInfo(o.zid).then(function (conv: any) {
          winston.log("info", "joinWithZidOrSuzinvite convinfo done");
          o.conv = conv;
          return o;
        });
      })
      .then(function (o: { lti_users_only: any; uid?: any }) {
        if (o.lti_users_only) {
          if (o.uid) {
            return pgQueryP("select * from lti_users where uid = ($1)", [
              o.uid,
            ]).then(function (rows: string | any[]) {
              if (rows && rows.length) {
                return o;
              } else {
                throw new Error("polis_err_missing_lti_user_for_uid");
              }
            });
          } else {
            throw new Error("polis_err_need_uid_to_check_lti_users");
          }
        } else {
          return o;
        }
      })
      .then(function (o: { uid?: any; user: any }) {
        winston.log("info", "joinWithZidOrSuzinvite userinfo begin");
        if (!o.uid) {
          winston.log("info", "joinWithZidOrSuzinvite userinfo nope");
          return o;
        }
        return getUserInfoForUid2(o.uid).then(function (user: any) {
          winston.log("info", "joinWithZidOrSuzinvite userinfo done");
          o.user = user;
          return o;
        });
      })
      // Commenting out for now until we have proper workflow for user.
      // .then(function(o) {
      //   winston.log("info","joinWithZidOrSuzinvite check email");
      // if (o.conv.owner_sees_participation_stats) {
      //   // User stats can be provided either by having the users sign in with polis
      //   // or by having them join via suurls.
      //   if (!(o.user && o.user.email) && !o.suzinvite) { // may want to inspect the contenst of the suzinvite info object instead of just the suzinvite
      //     throw new Error("polis_err_need_full_user_for_zid_" + o.conv.zid + "_and_uid_" + (o.user&&o.user.uid));
      //   }
      // }
      // return o;
      // })
      .then(function (o: { uid?: any }) {
        if (o.uid) {
          return o;
        } else {
          return createDummyUser().then(function (uid?: any) {
            return Object.assign(o, {
              uid: uid,
            });
          });
        }
      })
      .then(function (o: { zid: any; answers: any }) {
        return userHasAnsweredZeQuestions(o.zid, o.answers).then(function () {
          // looks good, pass through
          return o;
        });
      })
      .then(function (o: {
        referrer: any;
        parent_url: any;
        zid: any;
        uid?: any;
        answers: any;
      }) {
        const info: ParticipantInfo = {};
        if (o.referrer) {
          info.referrer = o.referrer;
        }
        if (o.parent_url) {
          info.parent_url = o.parent_url;
        }
        // TODO_REFERRER add info as third arg
        return joinConversation(o.zid, o.uid, info, o.answers).then(function (
          ptpt: any
        ) {
          return Object.assign(o, ptpt);
        });
      })
      .then(function (o: {
        xid: any;
        conv: { org_id: any; use_xid_whitelist: any; owner: any };
        uid?: any;
      }) {
        if (o.xid) {
          // used for suzinvite case

          return xidExists(o.xid, o.conv.org_id, o.uid).then(function (
            exists: any
          ) {
            if (exists) {
              // skip creating the entry (workaround for posgres's lack of upsert)
              return o;
            }
            const shouldCreateXidEntryPromise = o.conv.use_xid_whitelist
              ? isXidWhitelisted(o.conv.owner, o.xid)
              : Promise.resolve(true);
            shouldCreateXidEntryPromise.then((should: any) => {
              if (should) {
                return createXidEntry(o.xid, o.conv.org_id, o.uid).then(
                  function () {
                    return o;
                  }
                );
              } else {
                throw new Error("polis_err_xid_not_whitelisted");
              }
            });
          });
        } else {
          return o;
        }
      })
      .then(function (o: { suzinvite: any }) {
        if (o.suzinvite) {
          return deleteSuzinvite(o.suzinvite).then(function () {
            return o;
          });
        } else {
          return o;
        }
      })
  );
}

function startSessionAndAddCookies(req: any, res: any, uid?: any) {
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: Error) => void
  ) {
    startSession(uid, function (err: any, token: any) {
      if (err) {
        reject(new Error("polis_err_reg_failed_to_start_session"));
        return;
      }
      resolve(addCookies(req, res, token, uid));
    });
  });
}

// Facebook

function handle_GET_perfStats(req: any, res: { json: (arg0: any) => void }) {
  res.json(METRICS_IN_RAM);
}

function getFirstForPid(votes: string | any[]) {
  const seen = {};
  const len = votes.length;
  const firstVotes = [];
  for (let i = 0; i < len; i++) {
    const vote = votes[i];

    if (!seen[vote.pid]) {
      firstVotes.push(vote);
      seen[vote.pid] = true;
    }
  }
  return firstVotes;
}

// Domains

function handle_GET_conversationStats(
  req: { p: { zid: any; uid?: any; until: any; rid: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: {
        (arg0: {
          voteTimes: any;
          firstVoteTimes: any[];
          commentTimes: any;
          firstCommentTimes: any[];
          votesHistogram: any;
          burstHistogram: any[];
        }): void;
        new (): any;
      };
    };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const until = req.p.until;

  const hasPermission = req.p.rid
    ? Promise.resolve(!!req.p.rid)
    : isModerator(zid, uid);

  hasPermission
    .then(function (ok: any) {
      if (!ok) {
        fail(
          res,
          403,
          "polis_err_conversationStats_need_report_id_or_moderation_permission"
        );
        return;
      }

      const args = [zid];

      const q0 = until
        ? "select created, pid, mod from comments where zid = ($1) and created < ($2) order by created;"
        : "select created, pid, mod from comments where zid = ($1) order by created;";

      const q1 = until
        ? "select created, pid from votes where zid = ($1) and created < ($2) order by created;"
        : "select created, pid from votes where zid = ($1) order by created;";

      if (until) {
        args.push(until);
      }

      return Promise.all([
        pgQueryP_readOnly(q0, args),
        pgQueryP_readOnly(q1, args),
      ]).then(function (a: any[]) {
        function castTimestamp(o: { created: number }) {
          o.created = Number(o.created);
          return o;
        }
        const comments = _.map(a[0], castTimestamp);
        const votes = _.map(a[1], castTimestamp);
        // let uniqueHits = _.map(a[2], castTimestamp); // participants table
        // let votesHistogram = a[2];
        // let socialUsers = _.map(a[4], castTimestamp);

        const votesGroupedByPid = _.groupBy(votes, "pid");
        const votesHistogramObj = {};
        _.each(
          votesGroupedByPid,
          function (votesByParticipant: string | any[], pid: any) {
            votesHistogramObj[votesByParticipant.length] =
              votesHistogramObj[votesByParticipant.length] + 1 || 1;
          }
        );
        let votesHistogram: { n_votes: any; n_ptpts: any }[] = [];
        _.each(votesHistogramObj, function (ptptCount: any, voteCount: any) {
          votesHistogram.push({
            n_votes: voteCount,
            n_ptpts: ptptCount,
          });
        });
        votesHistogram.sort(function (a, b) {
          return a.n_ptpts - b.n_ptpts;
        });

        const burstsForPid = {};
        const interBurstGap = 10 * 60 * 1000; // a 10 minute gap between votes counts as a gap between bursts
        _.each(
          votesGroupedByPid,
          function (
            votesByParticipant: string | any[],
            pid: string | number
          ) {
            burstsForPid[pid] = 1;
            let prevCreated = votesByParticipant.length
              ? votesByParticipant[0]
              : 0;
            for (let v = 1; v < votesByParticipant.length; v++) {
              const vote = votesByParticipant[v];
              if (interBurstGap + prevCreated < vote.created) {
                burstsForPid[pid] += 1;
              }
              prevCreated = vote.created;
            }
          }
        );
        const burstHistogramObj = {};
        _.each(burstsForPid, function (bursts: string | number, pid: any) {
          burstHistogramObj[bursts] = burstHistogramObj[bursts] + 1 || 1;
        });
        const burstHistogram: { n_ptpts: any; n_bursts: number }[] = [];
        _.each(burstHistogramObj, function (ptptCount: any, burstCount: any) {
          burstHistogram.push({
            n_ptpts: ptptCount,
            n_bursts: Number(burstCount),
          });
        });
        burstHistogram.sort(function (a, b) {
          return a.n_bursts - b.n_bursts;
        });

        // since an agree vote is submitted for each comment's author, this includes people who only wrote a comment,
        // but didn't explicitly vote.
        let actualParticipants = getFirstForPid(votes);
        actualParticipants = _.pluck(actualParticipants, "created");
        let commenters = getFirstForPid(comments);
        commenters = _.pluck(commenters, "created");

        const totalComments = _.pluck(comments, "created");
        const totalVotes = _.pluck(votes, "created");

        votesHistogram = _.map(
          votesHistogram,
          function (x: { n_votes: any; n_ptpts: any }) {
            return {
              n_votes: Number(x.n_votes),
              n_ptpts: Number(x.n_ptpts),
            };
          }
        );

        res.status(200).json({
          voteTimes: totalVotes,
          firstVoteTimes: actualParticipants,
          commentTimes: totalComments,
          firstCommentTimes: commenters,
          votesHistogram: votesHistogram,
          burstHistogram: burstHistogram,
        });
      });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_conversationStats_misc", err);
    });
}

function handle_GET_snapshot(
  req: { p: { uid?: any; zid: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: {
        (arg0: { zid: any; zinvite: any; url: string }): void;
        new (): any;
      };
    };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;

  if (true) {
    throw new Error(
      "TODO Needs to clone participants_extended and any other new tables as well."
    );
  }
  if (isPolisDev(uid)) {
    // is polis developer
  } else {
    fail(res, 403, "polis_err_permissions");
    return;
  }

  pgQuery(
    "insert into conversations (topic, description, link_url, owner, modified, created, participant_count) " +
      "(select '(SNAPSHOT) ' || topic, description, link_url, $2, now_as_millis(), created, participant_count from conversations where zid = $1) returning *;",
    [zid, uid],
    function (err: any, result: { rows: any[] }) {
      if (err) {
        fail(res, 500, "polis_err_cloning_conversation", err);
        return;
      }
      // winston.log("info",rows);
      const conv = result.rows[0];

      // let conv = rows[0];
      const newZid = conv.zid;
      return pgQueryP(
        "insert into participants (pid, zid, uid, created, mod, subscribed) " +
          "select pid, ($2), uid, created, mod, 0 from participants where zid = ($1);",
        [zid, newZid]
      )
        .then(function () {
          return pgQueryP(
            "insert into comments (pid, tid, zid, txt, velocity, mod, uid, active, lang, lang_confidence, created) " +
              "select pid, tid, ($2), txt, velocity, mod, uid, active, lang, lang_confidence, created from comments where zid = ($1);",
            [zid, newZid]
          ).then(function () {
            return pgQueryP("select * from votes where zid = ($1);", [
              zid,
            ]).then((votes: any[]) => {
              // insert votes one at a time.
              return Promise.all(
                votes.map(function (v: {
                  pid: any;
                  tid: any;
                  vote: any;
                  created: any;
                }) {
                  const q =
                    "insert into votes (zid, pid, tid, vote, created) values ($1, $2, $3, $4, $5);";
                  return pgQueryP(q, [
                    newZid,
                    v.pid,
                    v.tid,
                    v.vote,
                    v.created,
                  ]);
                })
              ).then(function () {
                return generateAndRegisterZinvite(newZid, true).then(
                  function (zinvite: string) {
                    res.status(200).json({
                      zid: newZid,
                      zinvite: zinvite,
                      url: getServerNameWithProtocol(req) + "/" + zinvite,
                    });
                  }
                );
              });
            });
          });
        })
        .catch(function (err: any) {
          fail(res, 500, "polis_err_cloning_conversation_misc", err);
        });
    }
  );
}

// Facebook.deux;

function handle_POST_auth_new(req: any, res: any) {
  CreateUser.createUser(req, res);
} // end /api/v3/auth/new

function handle_POST_tutorial(
  req: { p: { uid?: any; step: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const uid = req.p.uid;
  const step = req.p.step;
  pgQueryP("update users set tut = ($1) where uid = ($2);", [step, uid])
    .then(function () {
      res.status(200).json({});
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_saving_tutorial_state", err);
    });
}

function handle_GET_users(
  req: { p: { uid?: any; errIfNoAuth: any; xid: any; owner_uid?: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const uid = req.p.uid;

  if (req.p.errIfNoAuth && !uid) {
    fail(res, 401, "polis_error_auth_needed");
    return;
  }

  getUser(uid, null, req.p.xid, req.p.owner_uid)
    .then(
      function (user: any) {
        res.status(200).json(user);
      },
      function (err: any) {
        fail(res, 500, "polis_err_getting_user_info2", err);
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_getting_user_info", err);
    });
}

const getUser = User.getUser;

const getComments = Comment.getComments;
const _getCommentsForModerationList = Comment._getCommentsForModerationList;
const _getCommentsList = Comment._getCommentsList;
const getNumberOfCommentsRemaining = Comment.getNumberOfCommentsRemaining;

/*
 Rename column 'zid' to 'conversation_id', add a new column called 'zid' and have that be a VARCHAR of limited length.
 Use conversation_id internally, refactor math poller to use conversation_id
 continue to use zid externally, but it will be a string of limited length
 Don't expose the conversation_id to the client.

 plan:
 add the new column conversation_id, copy values from zid
 change the code to look things up by conversation_id

*/

function handle_GET_participation(
  req: { p: { zid: any; uid?: any; strict: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const strict = req.p.strict;
  isOwner(zid, uid)
    .then(function (ok: any) {
      if (!ok) {
        fail(res, 403, "polis_err_get_participation_auth");
        return;
      }

      return Promise.all([
        pgQueryP_readOnly(
          "select pid, count(*) from votes where zid = ($1) group by pid;",
          [zid]
        ),
        pgQueryP_readOnly(
          "select pid, count(*) from comments where zid = ($1) group by pid;",
          [zid]
        ),
        getXids(zid), //pgQueryP_readOnly("select pid, xid from xids inner join (select * from participants where zid = ($1)) as p on xids.uid = p.uid;", [zid]),
      ]).then(function (o: any[]) {
        const voteCountRows = o[0];
        const commentCountRows = o[1];
        const pidXidRows = o[2];
        let i, r;

        if (strict && !pidXidRows.length) {
          fail(
            res,
            409,
            "polis_err_get_participation_missing_xids This conversation has no xids for its participants."
          );
          return;
        }

        // Build a map like this {xid -> {votes: 10, comments: 2}}
        //           (property) votes: number
        let result = new DD(function () {
          return {
            votes: 0,
            comments: 0,
          };
        });

        // Count votes
        for (i = 0; i < voteCountRows.length; i++) {
          r = voteCountRows[i];
          result.g(r.pid).votes = Number(r.count);
        }
        // Count comments
        for (i = 0; i < commentCountRows.length; i++) {
          r = commentCountRows[i];
          result.g(r.pid).comments = Number(r.count);
        }

        // convert from DD to POJO
        result = result.m;

        if (pidXidRows && pidXidRows.length) {
          // Convert from {pid -> foo} to {xid -> foo}
          const pidToXid = {};
          for (i = 0; i < pidXidRows.length; i++) {
            pidToXid[pidXidRows[i].pid] = pidXidRows[i].xid;
          }
          const xidBasedResult = {};
          let size = 0;
          _.each(result, function (val: any, key: string | number) {
            xidBasedResult[pidToXid[key]] = val;
            size += 1;
          });

          if (
            strict &&
            (commentCountRows.length || voteCountRows.length) &&
            size > 0
          ) {
            fail(
              res,
              409,
              "polis_err_get_participation_missing_xids This conversation is missing xids for some of its participants."
            );
            return;
          }
          res.status(200).json(xidBasedResult);
        } else {
          res.status(200).json(result);
        }
      });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_get_participation_misc", err);
    });
}
function getAgeRange(demo: Demo) {
  const currentYear = new Date().getUTCFullYear();
  const birthYear = demo.ms_birth_year_estimate_fb;
  if (_.isNull(birthYear) || _.isUndefined(birthYear) || _.isNaN(birthYear)) {
    return "?";
  }
  const age = currentYear - birthYear;
  if (age < 12) {
    return "0-11";
  } else if (age < 18) {
    return "12-17";
  } else if (age < 25) {
    return "18-24";
  } else if (age < 35) {
    return "25-34";
  } else if (age < 45) {
    return "35-44";
  } else if (age < 55) {
    return "45-54";
  } else if (age < 65) {
    return "55-64";
  } else {
    return "65+";
  }
}

// 0 male, 1 female, 2 other, or NULL
function getGender(demo: Demo) {
  let gender = demo.fb_gender;
  if (_.isNull(gender) || _.isUndefined(gender)) {
    gender = demo.ms_gender_estimate_fb;
  }
  return gender;
}

function getDemographicsForVotersOnComments(zid: any, comments: any[]) {
  function isAgree(v: { vote: any }) {
    return v.vote === polisTypes.reactions.pull;
  }
  function isDisgree(v: { vote: any }) {
    return v.vote === polisTypes.reactions.push;
  }
  function isPass(v: { vote: any }) {
    return v.vote === polisTypes.reactions.pass;
  }

  function isGenderMale(demo: { gender: number }) {
    return demo.gender === 0;
  }
  function isGenderFemale(demo: { gender: number }) {
    return demo.gender === 1;
  }
  function isGenderUnknown(demo: { gender: any }) {
    const gender = demo.gender;
    return gender !== 0 && gender !== 1;
  }

  return Promise.all([
    pgQueryP(
      "select pid,tid,vote from votes_latest_unique where zid = ($1);",
      [zid]
    ),
    pgQueryP(
      "select p.pid, d.* from participants p left join demographic_data d on p.uid = d.uid where p.zid = ($1);",
      [zid]
    ),
  ]).then((a: any[]) => {
    let votes = a[0];
    let demo = a[1];
    demo = demo.map((d: Demo) => {
      return {
        pid: d.pid,
        gender: getGender(d),
        ageRange: getAgeRange(d),
      };
    });
    const demoByPid = _.indexBy(demo, "pid");

    votes = votes.map((v: { pid: string | number }) => {
      return _.extend(v, demoByPid[v.pid]);
    });

    const votesByTid = _.groupBy(votes, "tid");

    // TODO maybe we should actually look at gender, then a/d/p %
    // TODO maybe we should actually look at each age range, then a/d/p %
    // that will be more natrual in cases of unequal representation

    return comments.map(
      (c: {
        tid: string | number;
        demographics: {
          gender: {
            m: { agree: any; disagree: any; pass: any };
            f: { agree: any; disagree: any; pass: any };
            "?": { agree: any; disagree: any; pass: any };
          };
          // TODO return all age ranges even if zero.
          age: any;
        };
      }) => {
        const votesForThisComment = votesByTid[c.tid];

        if (!votesForThisComment || !votesForThisComment.length) {
          console.log("skipping");
          return c;
        }

        const agrees = votesForThisComment.filter(isAgree);
        const disagrees = votesForThisComment.filter(isDisgree);
        const passes = votesForThisComment.filter(isPass);

        const votesByAgeRange = _.groupBy(votesForThisComment, "ageRange");

        c.demographics = {
          gender: {
            m: {
              agree: agrees.filter(isGenderMale).length,
              disagree: disagrees.filter(isGenderMale).length,
              pass: passes.filter(isGenderMale).length,
            },
            f: {
              agree: agrees.filter(isGenderFemale).length,
              disagree: disagrees.filter(isGenderFemale).length,
              pass: passes.filter(isGenderFemale).length,
            },
            "?": {
              agree: agrees.filter(isGenderUnknown).length,
              disagree: disagrees.filter(isGenderUnknown).length,
              pass: passes.filter(isGenderUnknown).length,
            },
          },
          // TODO return all age ranges even if zero.
          age: _.mapObject(votesByAgeRange, (votes: any, ageRange: any) => {
            const o = _.countBy(votes, "vote");
            return {
              agree: o[polisTypes.reactions.pull],
              disagree: o[polisTypes.reactions.push],
              pass: o[polisTypes.reactions.pass],
            };
          }),
        };
        return c;
      }
    );
  });
}

const translateAndStoreComment = Comment.translateAndStoreComment;

function handle_GET_comments_translations(
  req: { p: { zid: any; tid: any; lang: string } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const zid = req.p.zid;
  const tid = req.p.tid;
  const firstTwoCharsOfLang = req.p.lang.substr(0, 2);

  getComment(zid, tid)
    .then((comment: { txt: any }) => {
      return dbPgQuery
        .queryP(
          "select * from comment_translations where zid = ($1) and tid = ($2) and lang LIKE '$3%';",
          [zid, tid, firstTwoCharsOfLang]
        )
        .then((existingTranslations: any) => {
          if (existingTranslations) {
            return existingTranslations;
          }
          return translateAndStoreComment(zid, tid, comment.txt, req.p.lang);
        })
        .then((rows: any) => {
          res.status(200).json(rows || []);
        });
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_get_comments_translations", err);
    });
}

function handle_GET_comments(
  req: {
    headers?: Headers;
    p: { rid: any; include_demographics: any; zid: any; uid?: any };
  },
  res: any
) {
  const rid =
    req?.headers?.["x-request-id"] + " " + req?.headers?.["user-agent"];
  winston.log("info", "getComments " + rid + " begin");

  const isReportQuery = !_.isUndefined(req.p.rid);

  getComments(req.p)
    .then(function (comments: any[]) {
      if (req.p.rid) {
        return pgQueryP(
          "select tid, selection from report_comment_selections where rid = ($1);",
          [req.p.rid]
        ).then((selections: any) => {
          const tidToSelection = _.indexBy(selections, "tid");
          comments = comments.map(
            (c: { includeInReport: any; tid: string | number }) => {
              c.includeInReport =
                tidToSelection[c.tid] && tidToSelection[c.tid].selection > 0;
              return c;
            }
          );
          return comments;
        });
      } else {
        return comments;
      }
    })
    .then(function (comments: any[]) {
      comments = comments.map(function (c: {
        social: {
          twitter_user_id: string;
          twitter_profile_image_url_https: string;
          fb_user_id: any;
          fb_picture: string;
        };
      }) {
        const hasTwitter = c.social && c.social.twitter_user_id;
        if (hasTwitter) {
          c.social.twitter_profile_image_url_https =
            getServerNameWithProtocol(req) +
            "/twitter_image?id=" +
            c.social.twitter_user_id;
        }
        const hasFacebook = c.social && c.social.fb_user_id;
        if (hasFacebook) {
          const width = 40;
          const height = 40;
          c.social.fb_picture = `https://graph.facebook.com/v2.2/${c.social.fb_user_id}/picture?width=${width}&height=${height}`;
        }
        return c;
      });

      if (req.p.include_demographics) {
        isModerator(req.p.zid, req.p.uid)
          .then((owner: any) => {
            if (owner || isReportQuery) {
              return getDemographicsForVotersOnComments(req.p.zid, comments)
                .then((commentsWithDemographics: any) => {
                  finishArray(res, commentsWithDemographics);
                })
                .catch((err: any) => {
                  fail(res, 500, "polis_err_get_comments3", err);
                });
            } else {
              fail(res, 500, "polis_err_get_comments_permissions");
            }
          })
          .catch((err: any) => {
            fail(res, 500, "polis_err_get_comments2", err);
          });
      } else {
        finishArray(res, comments);
      }
    })
    .catch(function (err: any) {
      winston.log("info", "getComments " + rid + " failed");
      fail(res, 500, "polis_err_get_comments", err);
    });
} // end GET /api/v3/comments
function isDuplicateKey(err: {
  code: string | number;
  sqlState: string | number;
  messagePrimary: string | string[];
}) {
  const isdup =
    err.code === 23505 ||
    err.code === "23505" ||
    err.sqlState === 23505 ||
    err.sqlState === "23505" ||
    (err.messagePrimary &&
      err.messagePrimary.includes("duplicate key value"));
  return isdup;
}

function failWithRetryRequest(res: {
  setHeader: (arg0: string, arg1: number) => void;
  writeHead: (
    arg0: number
  ) => { (): any; new (): any; send: { (arg0: number): void; new (): any } };
}) {
  res.setHeader("Retry-After", 0);
  console.warn(57493875);
  res.writeHead(500).send(57493875);
}

function getNumberOfCommentsWithModerationStatus(zid: any, mod: any) {
  return new MPromise(
    "getNumberOfCommentsWithModerationStatus",
    function (resolve: (arg0: any) => void, reject: (arg0: any) => void) {
      pgQuery_readOnly(
        "select count(*) from comments where zid = ($1) and mod = ($2);",
        [zid, mod],
        function (err: any, result: { rows: { count: any }[] }) {
          if (err) {
            reject(err);
          } else {
            let count =
              result && result.rows && result.rows[0] && result.rows[0].count;
            count = Number(count);
            if (isNaN(count)) {
              count = void 0;
            }
            resolve(count);
          }
        }
      );
    }
  );
}

function sendCommentModerationEmail(
  req: any,
  uid: number,
  zid: any,
  unmoderatedCommentCount: string | number
) {
  if (_.isUndefined(unmoderatedCommentCount)) {
    unmoderatedCommentCount = "";
  }
  let body = unmoderatedCommentCount;
  if (unmoderatedCommentCount === 1) {
    body += " Statement is waiting for your review here: ";
  } else {
    body += " Statements are waiting for your review here: ";
  }

  getZinvite(zid)
    .catch(function (err: any) {
      console.error(err);
      yell("polis_err_getting_zinvite");
      return void 0;
    })
    .then(function (zinvite: any) {
      // NOTE: the counter goes in the email body so it doesn't create a new email thread (in Gmail, etc)

      body += createProdModerationUrl(zinvite);

      body += "\n\nThank you for using Polis.";

      // NOTE: adding a changing element (date) at the end to prevent gmail from thinking the URL is a signature,
      // and hiding it. (since the URL doesn't change between emails, Gmail tries to be smart, and hides it)
      // "Sent: " + Date.now() + "\n";

      // NOTE: Adding zid to the subject to force the email client to create a new email thread.
      return sendEmailByUid(
        uid,
        `Waiting for review (conversation ${zinvite})`,
        body
      );
    })
    .catch(function (err: any) {
      console.error(err);
    });
}

function createProdModerationUrl(zinvite: string) {
  return "https://pol.is/m/" + zinvite;
}

function createModerationUrl(
  req: { p?: ConversationType; protocol?: string; headers?: Headers },
  zinvite: string
) {
  let server = Config.getServerUrl();
  if (domainOverride) {
    server = req?.protocol + "://" + domainOverride;
  }

  if (req?.headers?.host?.includes("preprod.pol.is")) {
    server = "https://preprod.pol.is";
  }
  const url = server + "/m/" + zinvite;
  return url;
}

function moderateComment(
  zid: string,
  tid: number,
  active: boolean,
  mod: boolean,
  is_meta: boolean
) {
  return new Promise(function (
    resolve: () => void,
    reject: (arg0: any) => void
  ) {
    pgQuery(
      "UPDATE COMMENTS SET active=($3), mod=($4), modified=now_as_millis(), is_meta = ($5) WHERE zid=($1) and tid=($2);",
      [zid, tid, active, mod, is_meta],
      function (err: any) {
        if (err) {
          reject(err);
        } else {
          // TODO an optimization would be to only add the task when the comment becomes visible after the mod.
          addNotificationTask(zid);

          resolve();
        }
      }
    );
  });
}

const getComment = Comment.getComment;

function hasBadWords(txt: string) {
  txt = txt.toLowerCase();
  const tokens = txt.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    if (badwords[tokens[i]]) {
      return true;
    }
  }
  return false;
}

function commentExists(zid: any, txt: any) {
  return pgQueryP(
    "select zid from comments where zid = ($1) and txt = ($2);",
    [zid, txt]
  ).then(function (rows: string | any[]) {
    return rows && rows.length;
  });
}

// Comments.handlePostComments;

// Votes.handleGetVotesMe;

function handle_GET_votes(req: { p: any }, res: any) {
  getVotesForSingleParticipant(req.p).then(
    function (votes: any) {
      finishArray(res, votes);
    },
    function (err: any) {
      fail(res, 500, "polis_err_votes_get", err);
    }
  );
}

function selectProbabilistically(
  comments: any,
  priorities: { [x: string]: any },
  nTotal: number,
  nRemaining: number
) {
  // Here we go through all of the comments we might select for the user and add their priority values
  const lookup = _.reduce(
    comments,
    (
      o: { lastCount: any; lookup: any[][] },
      comment: { tid: string | number }
    ) => {
      // If we like, we can use nTotal and nRemaining here to figure out how much we should emphasize the
      // priority, potentially. Maybe we end up with different classes of priorities lists for this purpose?
      // scaling this value in some way may also be helpful.
      const lookup_val = o.lastCount + (priorities[comment.tid] || 1);
      o.lookup.push([lookup_val, comment]);
      o.lastCount = lookup_val;
      return o;
    },
    { lastCount: 0, lookup: [] }
  );
  // We arrange a random number that should fall somewhere in the range of the lookup_vals
  const randomN = Math.random() * lookup.lastCount;
  // Return the first one that has a greater lookup; could eventually replace this with something smarter
  // that does a bisectional lookup if performance becomes an issue. But I want to keep the implementation
  // simple to reason about all other things being equal.
  const result = _.find(lookup.lookup, (x: number[]) => x[0] > randomN);
  const c = result?.[1];
  c.randomN = randomN;
  return c;
}

// This very much follows the outline of the random selection above, but factors out the probabilistic logic
// to the selectProbabilistically fn above.
function getNextPrioritizedComment(
  zid: string,
  pid: string,
  withoutTids: string | any[],
  include_social: any
) {

  const params: CommentType = {
    zid: zid,
    not_voted_by_pid: pid,
    include_social: include_social,
  };
  if (!_.isUndefined(withoutTids) && withoutTids.length) {
    params.withoutTids = withoutTids;
  }
  // What should we set timestamp to below in getPca? Is 0 ok? What triggers updates?
  return Promise.all([
    getComments(params),
    getPca(zid, 0),
    getNumberOfCommentsRemaining(zid, pid),
  ]).then((results: any[]) => {
    const comments = results[0];
    const math = results[1];
    const numberOfCommentsRemainingRows = results[2];
    if (!comments || !comments.length) {
      return null;
    } else if (
      !numberOfCommentsRemainingRows ||
      !numberOfCommentsRemainingRows.length
    ) {
      throw new Error(
        "polis_err_getNumberOfCommentsRemaining_" + zid + "_" + pid
      );
    }
    const commentPriorities = math
      ? math.asPOJO["comment-priorities"] || {}
      : {};
    const nTotal = Number(numberOfCommentsRemainingRows[0].total);
    const nRemaining = Number(numberOfCommentsRemainingRows[0].remaining);
    const c = selectProbabilistically(
      comments,
      commentPriorities,
      nTotal,
      nRemaining
    );
    c.remaining = nRemaining;
    c.total = nTotal;
    return c;
  });
}

function getCommentTranslations(zid: any, tid: any) {
  return dbPgQuery.queryP(
    "select * from comment_translations where zid = ($1) and tid = ($2);",
    [zid, tid]
  );
}

function getNextComment(
  zid?: any,
  pid?: any,
  withoutTids?: any,
  include_social?: boolean,
  lang?: string
) {
  return getNextPrioritizedComment(
    zid,
    pid,
    withoutTids,
    include_social
  ).then((c: CommentType) => {
    if (lang && c) {
      const firstTwoCharsOfLang = lang.substr(0, 2);
      return getCommentTranslations(zid, c.tid).then((translations: any) => {
        c.translations = translations;
        const hasMatch = _.some(translations, (t: { lang: string }) => {
          return t.lang.startsWith(firstTwoCharsOfLang);
        });
        if (!hasMatch) {
          return translateAndStoreComment(zid, c.tid, c.txt, lang).then(
            (translation: any) => {
              if (translation) {
                c.translations.push(translation);
              }
              return c;
            }
          );
        }
        return c;
      });
    } else if (c) {
      c.translations = [];
    }
    return c;
  });
}

// NOTE: only call this in response to a vote. Don't call this from a poll, like /api/v3/nextComment
function addNoMoreCommentsRecord(zid: any, pid: any) {
  return pgQueryP(
    "insert into event_ptpt_no_more_comments (zid, pid, votes_placed) values ($1, $2, " +
      "(select count(*) from votes where zid = ($1) and pid = ($2)))",
    [zid, pid]
  );
}

function handle_GET_nextComment(
  req: {
    timedout: any;
    p: {
      zid: any;
      not_voted_by_pid: any;
      without: any;
      include_social: any;
      lang: any;
    };
  },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  if (req.timedout) {
    return;
  }
  // NOTE: I tried to speed up this query by adding db indexes, and by removing queries like getConversationInfo and finishOne.
  //          They didn't help much, at least under current load, which is negligible. pg:diagnose isn't complaining about indexes.
  //      I think the direction to go as far as optimizing this is to asyncronously build up a synced in-ram list of next comments
  //        for each participant, for currently active conversations. (this would probably be a math-poller-esque process on another
  //         hostclass)
  //         Along with this would be to cache in ram info about moderation status of each comment so we can filter before returning a comment.

  getNextComment(
    req.p.zid,
    req.p.not_voted_by_pid,
    req.p.without,
    req.p.include_social,
    req.p.lang
  )
    .then(
      function (c: { currentPid: any }) {
        if (req.timedout) {
          return;
        }
        if (c) {
          if (!_.isUndefined(req.p.not_voted_by_pid)) {
            c.currentPid = req.p.not_voted_by_pid;
          }
          finishOne(res, c);
        } else {
          const o: CommentOptions = {};
          if (!_.isUndefined(req.p.not_voted_by_pid)) {
            o.currentPid = req.p.not_voted_by_pid;
          }
          res.status(200).json(o);
        }
      },
      function (err: any) {
        if (req.timedout) {
          return;
        }
        fail(res, 500, "polis_err_get_next_comment2", err);
      }
    )
    .catch(function (err: any) {
      if (req.timedout) {
        return;
      }
      fail(res, 500, "polis_err_get_next_comment", err);
    });
}

function handle_GET_participationInit(
  req: {
    p: {
      conversation_id: any;
      uid?: any;
      lang: string;
      zid: any;
      xid: any;
      owner_uid?: any;
      pid: any;
    };
    headers?: Headers;
    cookies: { [x: string]: any };
  },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: {
        (arg0: {
          user: any;
          ptpt: any;
          nextComment: any;
          conversation: any;
          votes: any;
          pca: any;
          famous: any;
          acceptLanguage: any;
        }): void;
        new (): any;
      };
    };
  }
) {
  console.log("logging handle_GET_participationInit req", req);

  function ifConv(
    f: {
      (
        zid: any,
        pid: any,
        withoutTids: any,
        include_social: any,
        lang?: any
      ): CommentType;
      (zid: any, uid?: any, lang?: any): any;
      (p: any): any;
      (zid: any, math_tick: any): any;
      (o: any, req: any): any;
      apply?: any;
    },
    args: any[]
  ) {
    if (req.p.conversation_id) {
      return f.apply(null, args);
    } else {
      return Promise.resolve(null);
    }
  }

  function ifConvAndAuth(f: (zid: any, uid?: any) => any, args: any[]) {
    if (req.p.uid) {
      return ifConv(f, args);
    } else {
      return Promise.resolve(null);
    }
  }

  const acceptLanguage =
    req?.headers?.["accept-language"] ||
    req?.headers?.["Accept-Language"] ||
    "en-US";

  if (req.p.lang === "acceptLang") {
    req.p.lang = acceptLanguage.substr(0, 2);
  }

  getPermanentCookieAndEnsureItIsSet(req, res);

  Promise.all([
    getUser(req.p.uid, req.p.zid, req.p.xid, req.p.owner_uid),
    ifConvAndAuth(getParticipant, [req.p.zid, req.p.uid]),
    ifConv(getNextComment, [req.p.zid, req.p.pid, [], true, req.p.lang]),
    ifConv(getOneConversation, [req.p.zid, req.p.uid, req.p.lang]),
    ifConv(getVotesForSingleParticipant, [req.p]),
    ifConv(getPca, [req.p.zid, -1]),
    ifConv(doFamousQuery, [req.p, req]),
  ])
    .then(
      function (arr: any[]) {
        const conv = arr[3];
        const o = {
          user: arr[0],
          ptpt: arr[1],
          nextComment: arr[2],
          conversation: conv,
          votes: arr[4] || [],
          pca: arr[5] ? (arr[5].asJSON ? arr[5].asJSON : null) : null,
          famous: arr[6],
          acceptLanguage: acceptLanguage,
        };
        if (o.conversation) {
          delete o.conversation.zid;
          o.conversation.conversation_id = req.p.conversation_id;
        }
        if (o.ptpt) {
          delete o.ptpt.zid;
        }
        for (let i = 0; i < o.votes.length; i++) {
          delete o.votes[i].zid; // strip zid for security
        }
        if (!o.nextComment) {
          o.nextComment = {};
        }
        if (!_.isUndefined(req.p.pid)) {
          o.nextComment.currentPid = req.p.pid;
        }

        res.status(200).json(o);
      },
      function (err: any) {
        console.error(err);
        fail(res, 500, "polis_err_get_participationInit2", err);
      }
    )
    .catch(function (err: any) {
      console.error(err);
      fail(res, 500, "polis_err_get_participationInit", err);
    });
}
