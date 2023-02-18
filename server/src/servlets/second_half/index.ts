
function updateConversationModifiedTime(zid: any, t?: undefined) {
  const modified = _.isUndefined(t) ? Date.now() : Number(t);
  let query =
    "update conversations set modified = ($2) where zid = ($1) and modified < ($2);";
  let params = [zid, modified];
  if (_.isUndefined(t)) {
    query =
      "update conversations set modified = now_as_millis() where zid = ($1);";
    params = [zid];
  }
  return pgQueryP(query, params);
}

const createXidRecordByZid = Conversation.createXidRecordByZid;
const getXidStuff = User.getXidStuff;

function handle_PUT_participants_extended(
  req: { p: { zid: any; uid?: any; show_translation_activated: any } },
  res: { json: (arg0: any) => void }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;

  const fields: ParticipantFields = {};
  if (!_.isUndefined(req.p.show_translation_activated)) {
    fields.show_translation_activated = req.p.show_translation_activated;
  }

  const q = sql_participants_extended
    .update(fields)
    .where(sql_participants_extended.zid.equals(zid))
    .and(sql_participants_extended.uid.equals(uid));

  pgQueryP(q.toString(), [])
    .then((result: any) => {
      res.json(result);
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_put_participants_extended", err);
    });
}

function handle_POST_votes(
  req: {
    p: Vote;
    cookies: { [x: string]: any };
    headers?: Headers;
  },
  res: any
) {
  const uid = req.p.uid; // PID_FLOW uid may be undefined here.
  const zid = req.p.zid;
  let pid = req.p.pid; // PID_FLOW pid may be undefined here.
  const lang = req.p.lang;

  // We allow viewing (and possibly writing) without cookies enabled, but voting requires cookies
  // (except the auto-vote on your own comment, which seems ok)
  const token = req.cookies[COOKIES.TOKEN];
  const apiToken = req?.headers?.authorization || "";
  const xPolisHeaderToken = req?.headers?.["x-polis"];
  if (!uid && !token && !apiToken && !xPolisHeaderToken) {
    fail(res, 403, "polis_err_vote_noauth");
    return;
  }

  const permanent_cookie = getPermanentCookieAndEnsureItIsSet(req, res);

  // PID_FLOW WIP for now assume we have a uid, but need a participant record.
  const pidReadyPromise = _.isUndefined(req.p.pid)
    ? addParticipantAndMetadata(
        req.p.zid,
        req.p.uid,
        req,
        permanent_cookie
      ).then(function (rows: any[]) {
        const ptpt = rows[0];
        pid = ptpt.pid;
      })
    : Promise.resolve();
  pidReadyPromise
    .then(function () {
      let vote;

      // PID_FLOW WIP for now assume we have a uid, but need a participant record.
      const pidReadyPromise = _.isUndefined(pid)
        ? addParticipant(zid, uid).then(function (rows: any[]) {
            const ptpt = rows[0];
            pid = ptpt.pid;
          })
        : Promise.resolve();

      return pidReadyPromise
        .then(function () {
          return votesPost(
            uid,
            pid,
            zid,
            req.p.tid,
            req.p.vote,
            req.p.weight,
            true
          );
        })
        .then(function (o: { vote: any }) {
          vote = o.vote;
          const createdTime = vote.created;
          setTimeout(function () {
            updateConversationModifiedTime(zid, createdTime);
            updateLastInteractionTimeForConversation(zid, uid);

            // NOTE: may be greater than number of comments, if they change votes
            updateVoteCount(zid, pid);
          }, 100);
          if (_.isUndefined(req.p.starred)) {
            return;
          } else {
            return addStar(zid, req.p.tid, pid, req.p.starred, createdTime);
          }
        })
        .then(function () {
          return getNextComment(zid, pid, [], true, lang);
        })
        .then(function (nextComment: any) {
          const result: PidReadyResult = {};
          if (nextComment) {
            result.nextComment = nextComment;
          } else {
            // no need to wait for this to finish
            addNoMoreCommentsRecord(zid, pid);
          }
          // PID_FLOW This may be the first time the client gets the pid.
          result.currentPid = pid;
          // result.shouldMod = true; // TODO
          if (result.shouldMod) {
            result.modOptions = {};
            if (req.p.vote === polisTypes.reactions.pull) {
              result.modOptions.as_important = true;
              result.modOptions.as_factual = true;
              result.modOptions.as_feeling = true;
            } else if (req.p.vote === polisTypes.reactions.push) {
              result.modOptions.as_notmyfeeling = true;
              result.modOptions.as_notgoodidea = true;
              result.modOptions.as_notfact = true;
              result.modOptions.as_abusive = true;
            } else if (req.p.vote === polisTypes.reactions.pass) {
              result.modOptions.as_unsure = true;
              result.modOptions.as_spam = true;
              result.modOptions.as_abusive = true;
            }
          }

          finishOne(res, result);
        });
    })
    .catch(function (err: string) {
      if (err === "polis_err_vote_duplicate") {
        fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
      } else if (err === "polis_err_conversation_is_closed") {
        fail(res, 403, "polis_err_conversation_is_closed", err);
      } else if (err === "polis_err_post_votes_social_needed") {
        fail(res, 403, "polis_err_post_votes_social_needed", err);
      } else {
        fail(res, 500, "polis_err_vote", err);
      }
    });
}

function handle_POST_ptptCommentMod(
  req: {
    p: {
      zid: any;
      pid: any;
      uid?: any;
      tid: any;
      as_abusive: any;
      as_factual: any;
      as_feeling: any;
      as_important: any;
      as_notfact: any;
      as_notgoodidea: any;
      as_notmyfeeling: any;
      as_offtopic: any;
      as_spam: any;
      unsure: any;
      lang: any;
    };
  },
  res: any
) {
  const zid = req.p.zid;
  const pid = req.p.pid;
  const uid = req.p.uid;

  return pgQueryP(
    "insert into crowd_mod (" +
      "zid, " +
      "pid, " +
      "tid, " +
      "as_abusive, " +
      "as_factual, " +
      "as_feeling, " +
      "as_important, " +
      "as_notfact, " +
      "as_notgoodidea, " +
      "as_notmyfeeling, " +
      "as_offtopic, " +
      "as_spam, " +
      "as_unsure) values (" +
      "$1, " +
      "$2, " +
      "$3, " +
      "$4, " +
      "$5, " +
      "$6, " +
      "$7, " +
      "$8, " +
      "$9, " +
      "$10, " +
      "$11, " +
      "$12, " +
      "$13);",
    [
      req.p.zid,
      req.p.pid,
      req.p.tid,
      req.p.as_abusive,
      req.p.as_factual,
      req.p.as_feeling,
      req.p.as_important,
      req.p.as_notfact,
      req.p.as_notgoodidea,
      req.p.as_notmyfeeling,
      req.p.as_offtopic,
      req.p.as_spam,
      req.p.unsure,
    ]
  )
    .then((createdTime: any) => {
      setTimeout(function () {
        updateConversationModifiedTime(req.p.zid, createdTime);
        updateLastInteractionTimeForConversation(zid, uid);
      }, 100);
    })
    .then(function () {
      // TODO req.p.lang is probably not defined
      return getNextComment(req.p.zid, pid, [], true, req.p.lang);
    })
    .then(function (nextComment: any) {
      const result: ParticipantCommentModerationResult = {};
      if (nextComment) {
        result.nextComment = nextComment;
      } else {
        // no need to wait for this to finish
        addNoMoreCommentsRecord(req.p.zid, pid);
      }
      // PID_FLOW This may be the first time the client gets the pid.
      result.currentPid = req.p.pid;
      finishOne(res, result);
    })
    .catch(function (err: string) {
      if (err === "polis_err_ptptCommentMod_duplicate") {
        // TODO allow for changing votes?
        fail(res, 406, "polis_err_ptptCommentMod_duplicate", err);
      } else if (err === "polis_err_conversation_is_closed") {
        fail(res, 403, "polis_err_conversation_is_closed", err);
      } else {
        fail(res, 500, "polis_err_ptptCommentMod", err);
      }
    });
}

function handle_POST_upvotes(
  req: { p: { uid?: any; zid: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;

  pgQueryP("select * from upvotes where uid = ($1) and zid = ($2);", [
    uid,
    zid,
  ]).then(
    function (rows: string | any[]) {
      if (rows && rows.length) {
        fail(res, 403, "polis_err_upvote_already_upvoted");
      } else {
        pgQueryP("insert into upvotes (uid, zid) VALUES ($1, $2);", [
          uid,
          zid,
        ]).then(
          function () {
            pgQueryP(
              "update conversations set upvotes = (select count(*) from upvotes where zid = ($1)) where zid = ($1);",
              [zid]
            ).then(
              function () {
                res.status(200).json({});
              },
              function (err: any) {
                fail(res, 500, "polis_err_upvote_update", err);
              }
            );
          },
          function (err: any) {
            fail(res, 500, "polis_err_upvote_insert", err);
          }
        );
      }
    },
    function (err: any) {
      fail(res, 500, "polis_err_upvote_check", err);
    }
  );
}

function addStar(
  zid: any,
  tid: any,
  pid: any,
  starred: number,
  created?: undefined
) {
  starred = starred ? 1 : 0;
  let query =
    "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, default) RETURNING created;";
  const params = [pid, zid, tid, starred];
  if (!_.isUndefined(created)) {
    query =
      "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, $5) RETURNING created;";
    params.push(created);
  }
  return pgQueryP(query, params);
}

function handle_POST_stars(
  req: { p: { zid: any; tid: any; pid: any; starred: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  addStar(req.p.zid, req.p.tid, req.p.pid, req.p.starred)
    .then(function (result: { rows: { created: any }[] }) {
      const createdTime = result.rows[0].created;
      setTimeout(function () {
        updateConversationModifiedTime(req.p.zid, createdTime);
      }, 100);
      // TODO don't stop after the first one, map the inserts to deferreds.
      res.status(200).json({});
    })
    .catch(function (err: any) {
      if (err) {
        if (isDuplicateKey(err)) {
          // TODO allow for changing votes?
          fail(res, 406, "polis_err_vote_duplicate", err);
        } else {
          fail(res, 500, "polis_err_vote", err);
        }
      }
    });
}

function handle_POST_trashes(
  req: { p: { pid: any; zid: any; tid: any; trashed: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const query =
    "INSERT INTO trashes (pid, zid, tid, trashed, created) VALUES ($1, $2, $3, $4, default);";
  const params = [req.p.pid, req.p.zid, req.p.tid, req.p.trashed];
  pgQuery(
    query,
    params,
    function (err: any, result: { rows: { created: any }[] }) {
      if (err) {
        if (isDuplicateKey(err)) {
          // TODO allow for changing votes?
          fail(res, 406, "polis_err_vote_duplicate", err);
        } else {
          fail(res, 500, "polis_err_vote", err);
        }
        return;
      }

      const createdTime = result.rows[0].created;
      setTimeout(function () {
        updateConversationModifiedTime(req.p.zid, createdTime);
      }, 100);

      // TODO don't stop after the first one, map the inserts to deferreds.
      res.status(200).json({});
    }
  );
}

function verifyMetadataAnswersExistForEachQuestion(zid: any) {
  const errorcode = "polis_err_missing_metadata_answers";
  return new Promise(function (
    resolve: () => void,
    reject: (arg0: Error) => void
  ) {
    pgQuery_readOnly(
      "select pmqid from participant_metadata_questions where zid = ($1);",
      [zid],
      function (err: any, results: { rows: any[] }) {
        if (err) {
          reject(err);
          return;
        }
        if (!results.rows || !results.rows.length) {
          resolve();
          return;
        }
        const pmqids = results.rows.map(function (row: { pmqid: any }) {
          return Number(row.pmqid);
        });
        pgQuery_readOnly(
          "select pmaid, pmqid from participant_metadata_answers where pmqid in (" +
            pmqids.join(",") +
            ") and alive = TRUE and zid = ($1);",
          [zid],
          function (err: any, results: { rows: any[] }) {
            if (err) {
              reject(err);
              return;
            }
            if (!results.rows || !results.rows.length) {
              reject(new Error(errorcode));
              return;
            }
            const questions = _.reduce(
              pmqids,
              function (o: { [x: string]: number }, pmqid: string | number) {
                o[pmqid] = 1;
                return o;
              },
              {}
            );
            results.rows.forEach(function (row: { pmqid: string | number }) {
              delete questions[row.pmqid];
            });
            if (Object.keys(questions).length) {
              reject(new Error(errorcode));
            } else {
              resolve();
            }
          }
        );
      }
    );
  });
}

function handle_PUT_comments(
  req: {
    p: { uid?: any; zid: any; tid: any; active: any; mod: any; is_meta: any };
  },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;
  const tid = req.p.tid;
  const active = req.p.active;
  const mod = req.p.mod;
  const is_meta = req.p.is_meta;

  isModerator(zid, uid)
    .then(function (isModerator: any) {
      if (isModerator) {
        moderateComment(zid, tid, active, mod, is_meta).then(
          function () {
            res.status(200).json({});
          },
          function (err: any) {
            fail(res, 500, "polis_err_update_comment", err);
          }
        );
      } else {
        fail(res, 403, "polis_err_update_comment_auth");
      }
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_update_comment", err);
    });
}

function handle_POST_reportCommentSelections(
  req: { p: { uid?: any; zid: any; rid: any; tid: any; include: any } },
  res: { json: (arg0: {}) => void }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;
  const rid = req.p.rid;
  const tid = req.p.tid;
  const selection = req.p.include ? 1 : -1;
  isModerator(zid, uid)
    .then((isMod: any) => {
      if (!isMod) {
        return fail(res, 403, "polis_err_POST_reportCommentSelections_auth");
      }
      return pgQueryP(
        "insert into report_comment_selections (rid, tid, selection, zid, modified) values ($1, $2, $3, $4, now_as_millis()) " +
          "on conflict (rid, tid) do update set selection = ($3), zid  = ($4), modified = now_as_millis();",
        [rid, tid, selection, zid]
      )
        .then(() => {
          // The old report isn't valid anymore, so when a user loads the report again a new worker_tasks entry will be created.
          return pgQueryP(
            "delete from math_report_correlationmatrix where rid = ($1);",
            [rid]
          );
        })
        .then(() => {
          res.json({});
        });
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_POST_reportCommentSelections_misc", err);
    });
}

// kind of crappy that we're replacing the zinvite.
// This is needed because we initially create a conversation with the POST, then actually set the properties with the subsequent PUT.
// if we stop doing that, we can remove this function.
function generateAndReplaceZinvite(zid: any, generateShortZinvite: any) {
  let len = 12;
  if (generateShortZinvite) {
    len = 6;
  }
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: string) => void
  ) {
    generateToken(len, false, function (err: any, zinvite: any) {
      if (err) {
        return reject("polis_err_creating_zinvite");
      }
      pgQuery(
        "update zinvites set zinvite = ($1) where zid = ($2);",
        [zinvite, zid],
        function (err: any, results: any) {
          if (err) {
            reject(err);
          } else {
            resolve(zinvite);
          }
        }
      );
    });
  });
}

function sendGradeForAssignment(
  oauth_consumer_key: any,
  oauth_consumer_secret: any,
  params: {
    lis_result_sourcedid: string;
    gradeFromZeroToOne: string;
    lis_outcome_service_url: any;
  }
) {
  const replaceResultRequestBody =
    "" +
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<imsx_POXEnvelopeRequest xmlns="http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0">' +
    "<imsx_POXHeader>" +
    "<imsx_POXRequestHeaderInfo>" +
    "<imsx_version>V1.0</imsx_version>" +
    "<imsx_messageIdentifier>999999123</imsx_messageIdentifier>" +
    "</imsx_POXRequestHeaderInfo>" +
    "</imsx_POXHeader>" +
    "<imsx_POXBody>" +
    // parser has???  xml.at_css('imsx_POXBody *:first').name.should == 'replaceResultResponse'
    "<replaceResultRequest>" +
    "<resultRecord>" +
    "<sourcedGUID>" +
    "<sourcedId>" +
    params.lis_result_sourcedid +
    "</sourcedId>" +
    "</sourcedGUID>" +
    "<result>" +
    "<resultScore>" +
    // this is the formatting of the resultScore (for example europe might use a comma.
    // Just stick to en formatting here.)
    "<language>en</language>" +
    "<textString>" +
    params.gradeFromZeroToOne +
    "</textString>" +
    "</resultScore>" +
    "</result>" +
    "</resultRecord>" +
    "</replaceResultRequest>" +
    "</imsx_POXBody>" +
    "</imsx_POXEnvelopeRequest>";

  const oauth = new OAuth.OAuth(
    null, //'https://api.twitter.com/oauth/request_token',
    null, //'https://api.twitter.com/oauth/access_token',
    oauth_consumer_key, //'your application consumer key',
    oauth_consumer_secret, //'your application secret',
    "1.0", //'1.0A',
    null,
    "HMAC-SHA1"
  );
  return new Promise(function (
    resolve: (arg0: any, arg1: any) => void,
    reject: (arg0: any) => void
  ) {
    oauth.post(
      params.lis_outcome_service_url, //'https://api.twitter.com/1.1/trends/place.json?id=23424977',
      void 0, //'your user token for this app', //test user token
      void 0, //'your user secret for this app', //test user secret
      replaceResultRequestBody,
      "application/xml",
      function (e: any, data: any, res: any) {
        if (e) {
          winston.log("info", "grades foo failed");
          console.error(e);
          reject(e);
        } else {
          winston.log("info", "grades foo ok!");
          resolve(params, data);
        }
      }
    );
  });
}

function sendCanvasGradesIfNeeded(zid: any, ownerUid: string) {
  // get the lti_user_ids for participants who voted or commented
  const goodLtiUserIdsPromise = pgQueryP(
    "select lti_user_id from " +
      "(select distinct uid from " +
      "(select distinct pid from votes where zid = ($1) UNION " +
      "select distinct pid from comments where zid = ($1)) as x " +
      "inner join participants p on x.pid = p.pid where p.zid = ($1)) as good_uids " +
      "inner join lti_users on good_uids.uid = lti_users.uid;",
    [zid]
  );

  const callbackInfoPromise = pgQueryP(
    "select * from canvas_assignment_conversation_info ai " +
      "inner join canvas_assignment_callback_info ci " +
      "on ai.custom_canvas_assignment_id = ci.custom_canvas_assignment_id " +
      "where ai.zid = ($1);",
    [zid]
  );

  const ownerLtiCredsPromise = pgQueryP(
    "select * from lti_oauthv1_credentials where uid = ($1);",
    [ownerUid]
  );

  return Promise.all([
    goodLtiUserIdsPromise,
    callbackInfoPromise,
    ownerLtiCredsPromise,
  ]).then(function (results: any[]) {
    const isFullPointsEarningLtiUserId = _.indexBy(results[0], "lti_user_id");
    const callbackInfos = results[1];
    if (!callbackInfos || !callbackInfos.length) {
      // TODO may be able to check for scenarios like missing callback infos, where votes and comments and
      // canvas_assignment_conversation_info exist, and then throw an error
      return;
    }
    let ownerLtiCreds = results[2];
    if (!ownerLtiCreds || !ownerLtiCreds.length) {
      throw new Error(
        "polis_err_lti_oauth_credentials_are_missing " + ownerUid
      );
    }
    ownerLtiCreds = ownerLtiCreds[0];
    if (
      !ownerLtiCreds.oauth_shared_secret ||
      !ownerLtiCreds.oauth_consumer_key
    ) {
      throw new Error("polis_err_lti_oauth_credentials_are_bad " + ownerUid);
    }

    const promises = callbackInfos.map(function (
      assignmentCallbackInfo: Assignment
    ) {
      const gradeFromZeroToOne = isFullPointsEarningLtiUserId[
        assignmentCallbackInfo.lti_user_id
      ]
        ? 1.0
        : 0.0;
      assignmentCallbackInfo.gradeFromZeroToOne = String(gradeFromZeroToOne);
      winston.log(
        "info",
        "grades assigned" +
          gradeFromZeroToOne +
          " lti_user_id " +
          assignmentCallbackInfo.lti_user_id
      );
      return sendGradeForAssignment(
        ownerLtiCreds.oauth_consumer_key,
        ownerLtiCreds.oauth_shared_secret,
        assignmentCallbackInfo
      );
    });
    return Promise.all(promises);
  });
}

function updateLocalRecordsToReflectPostedGrades(
  listOfGradingContexts: any[]
) {
  listOfGradingContexts = listOfGradingContexts || [];
  return Promise.all(
    listOfGradingContexts.map(function (gradingContext: {
      gradeFromZeroToOne: string;
      tool_consumer_instance_guid?: any;
      lti_context_id: any;
      lti_user_id: any;
      custom_canvas_assignment_id: any;
    }) {
      winston.log(
        "info",
        "grading set to " + gradingContext.gradeFromZeroToOne
      );
      return pgQueryP(
        "update canvas_assignment_callback_info set grade_assigned = ($1) where tool_consumer_instance_guid = ($2) and lti_context_id = ($3) and lti_user_id = ($4) and custom_canvas_assignment_id = ($5);",
        [
          gradingContext.gradeFromZeroToOne,
          gradingContext.tool_consumer_instance_guid,
          gradingContext.lti_context_id,
          gradingContext.lti_user_id,
          gradingContext.custom_canvas_assignment_id,
        ]
      );
    })
  );
}

function handle_GET_lti_oauthv1_credentials(
  req: { p: { uid: string } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: string): void; new (): any };
    };
  }
) {
  let uid = "FOO";
  if (req.p && req.p.uid) {
    uid = req.p.uid;
  }
  Promise.all([generateTokenP(40, false), generateTokenP(40, false)]).then(
    function (results: string[]) {
      const key = "polis_oauth_consumer_key_" + results[0];
      const secret = "polis_oauth_shared_secret_" + results[1];
      const x = [uid, "'" + key + "'", "'" + secret + "'"].join(",");
      // return the query, they we can manually run this in the pg shell, and email? the keys to the instructor
      res
        .status(200)
        .json(
          "INSERT INTO lti_oauthv1_credentials (uid, oauth_consumer_key, oauth_shared_secret) values (" +
            x +
            ") returning oauth_consumer_key, oauth_shared_secret;"
        );
    }
  );
}

function handle_POST_conversation_close(
  req: { p: { zid: any; uid?: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  let q = "select * from conversations where zid = ($1)";
  const params = [req.p.zid];
  if (!isPolisDev(req.p.uid)) {
    q = q + " and owner = ($2)";
    params.push(req.p.uid);
  }
  pgQueryP(q, params)
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        fail(res, 500, "polis_err_closing_conversation_no_such_conversation");
        return;
      }
      const conv = rows[0];
      // regardless of old state, go ahead and close it, and update grades. will make testing easier.
      pgQueryP(
        "update conversations set is_active = false where zid = ($1);",
        [conv.zid]
      )
        .then(function () {
          // might need to send some grades
          const ownerUid = req.p.uid;
          sendCanvasGradesIfNeeded(conv.zid, ownerUid)
            .then(function (listOfContexts: any) {
              return updateLocalRecordsToReflectPostedGrades(listOfContexts);
            })
            .then(function () {
              res.status(200).json({});
            })
            .catch(function (err: any) {
              fail(
                res,
                500,
                "polis_err_closing_conversation_sending_grades",
                err
              );
            });
        })
        .catch(function (err: any) {
          fail(res, 500, "polis_err_closing_conversation2", err);
        });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_closing_conversation", err);
    });
}

function handle_POST_conversation_reopen(
  req: { p: { zid: any; uid?: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  let q = "select * from conversations where zid = ($1)";
  const params = [req.p.zid];
  if (!isPolisDev(req.p.uid)) {
    q = q + " and owner = ($2)";
    params.push(req.p.uid);
  }
  pgQueryP(q, params)
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        fail(res, 500, "polis_err_closing_conversation_no_such_conversation");
        return;
      }
      const conv = rows[0];
      pgQueryP(
        "update conversations set is_active = true where zid = ($1);",
        [conv.zid]
      )
        .then(function () {
          res.status(200).json({});
        })
        .catch(function (err: any) {
          fail(res, 500, "polis_err_reopening_conversation2", err);
        });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_reopening_conversation", err);
    });
}

function handle_PUT_users(
  req: { p: { uid?: any; uid_of_user: any; email: any; hname: any } },
  res: { json: (arg0: any) => void }
) {
  let uid = req.p.uid;
  if (isPolisDev(uid) && req.p.uid_of_user) {
    uid = req.p.uid_of_user;
  }

  const fields: UserType = {};
  if (!_.isUndefined(req.p.email)) {
    fields.email = req.p.email;
  }
  if (!_.isUndefined(req.p.hname)) {
    fields.hname = req.p.hname;
  }

  const q = sql_users.update(fields).where(sql_users.uid.equals(uid));

  pgQueryP(q.toString(), [])
    .then((result: any) => {
      res.json(result);
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_put_user", err);
    });
}

function handle_PUT_conversations(
  req: {
    p: {
      short_url: any;
      zid: any;
      uid?: any;
      verifyMeta: any;
      is_active: any;
      is_anon: any;
      is_draft: any;
      is_data_open: any;
      profanity_filter: any;
      spam_filter: any;
      strict_moderation: any;
      topic: string;
      description: string;
      vis_type: any;
      help_type: any;
      socialbtn_type: any;
      bgcolor: string;
      help_color: string;
      help_bgcolor: string;
      style_btn: any;
      write_type: any;
      owner_sees_participation_stats: any;
      launch_presentation_return_url_hex: any;
      link_url: any;
      send_created_email: any;
      conversation_id: string;
      custom_canvas_assignment_id: any;
      tool_consumer_instance_guid?: any;
      context: any;
    };
  },
  res: any
) {
  const generateShortUrl = req.p.short_url;
  isModerator(req.p.zid, req.p.uid)
    .then(function (ok: any) {
      if (!ok) {
        fail(res, 403, "polis_err_update_conversation_permission");
        return;
      }

      let verifyMetaPromise;
      if (req.p.verifyMeta) {
        verifyMetaPromise = verifyMetadataAnswersExistForEachQuestion(
          req.p.zid
        );
      } else {
        verifyMetaPromise = Promise.resolve();
      }

      const fields: ConversationType = {};
      if (!_.isUndefined(req.p.is_active)) {
        fields.is_active = req.p.is_active;
      }
      if (!_.isUndefined(req.p.is_anon)) {
        fields.is_anon = req.p.is_anon;
      }
      if (!_.isUndefined(req.p.is_draft)) {
        fields.is_draft = req.p.is_draft;
      }
      if (!_.isUndefined(req.p.is_data_open)) {
        fields.is_data_open = req.p.is_data_open;
      }
      if (!_.isUndefined(req.p.profanity_filter)) {
        fields.profanity_filter = req.p.profanity_filter;
      }
      if (!_.isUndefined(req.p.spam_filter)) {
        fields.spam_filter = req.p.spam_filter;
      }
      if (!_.isUndefined(req.p.strict_moderation)) {
        fields.strict_moderation = req.p.strict_moderation;
      }
      if (!_.isUndefined(req.p.topic)) {
        fields.topic = req.p.topic;
      }
      if (!_.isUndefined(req.p.description)) {
        fields.description = req.p.description;
      }
      if (!_.isUndefined(req.p.vis_type)) {
        fields.vis_type = req.p.vis_type;
      }
      if (!_.isUndefined(req.p.help_type)) {
        fields.help_type = req.p.help_type;
      }
      if (!_.isUndefined(req.p.socialbtn_type)) {
        fields.socialbtn_type = req.p.socialbtn_type;
      }
      if (!_.isUndefined(req.p.bgcolor)) {
        if (req.p.bgcolor === "default") {
          fields.bgcolor = null;
        } else {
          fields.bgcolor = req.p.bgcolor;
        }
      }
      if (!_.isUndefined(req.p.help_color)) {
        if (req.p.help_color === "default") {
          fields.help_color = null;
        } else {
          fields.help_color = req.p.help_color;
        }
      }
      if (!_.isUndefined(req.p.help_bgcolor)) {
        if (req.p.help_bgcolor === "default") {
          fields.help_bgcolor = null;
        } else {
          fields.help_bgcolor = req.p.help_bgcolor;
        }
      }
      if (!_.isUndefined(req.p.style_btn)) {
        fields.style_btn = req.p.style_btn;
      }
      if (!_.isUndefined(req.p.write_type)) {
        fields.write_type = req.p.write_type;
      }
      ifDefinedSet("auth_needed_to_vote", req.p, fields);
      ifDefinedSet("auth_needed_to_write", req.p, fields);
      ifDefinedSet("auth_opt_fb", req.p, fields);
      ifDefinedSet("auth_opt_tw", req.p, fields);
      ifDefinedSet("auth_opt_allow_3rdparty", req.p, fields);

      if (!_.isUndefined(req.p.owner_sees_participation_stats)) {
        fields.owner_sees_participation_stats = !!req.p
          .owner_sees_participation_stats;
      }
      if (!_.isUndefined(req.p.launch_presentation_return_url_hex)) {
        fields.lti_users_only = true;
      }
      if (!_.isUndefined(req.p.link_url)) {
        fields.link_url = req.p.link_url;
      }

      ifDefinedSet("subscribe_type", req.p, fields);

      const q = sql_conversations
        .update(fields)
        .where(sql_conversations.zid.equals(req.p.zid))
        .returning("*");
      verifyMetaPromise.then(
        function () {
          pgQuery(q.toString(), function (err: any, result: { rows: any[] }) {
            if (err) {
              fail(res, 500, "polis_err_update_conversation", err);
              return;
            }
            const conv = result && result.rows && result.rows[0];
            // The first check with isModerator implictly tells us this can be returned in HTTP response.
            conv.is_mod = true;

            const promise = generateShortUrl
              ? generateAndReplaceZinvite(req.p.zid, generateShortUrl)
              : Promise.resolve();
            const successCode = generateShortUrl ? 201 : 200;

            promise
              .then(function () {
                // send notification email
                if (req.p.send_created_email) {
                  Promise.all([
                    getUserInfoForUid2(req.p.uid),
                    getConversationUrl(req, req.p.zid, true),
                  ])
                    .then(function (results: any[]) {
                      const hname = results[0].hname;
                      const url = results[1];
                      sendEmailByUid(
                        req.p.uid,
                        "Conversation created",
                        "Hi " +
                          hname +
                          ",\n" +
                          "\n" +
                          "Here's a link to the conversation you just created. Use it to invite participants to the conversation. Share it by whatever network you prefer - Gmail, Facebook, Twitter, etc., or just post it to your website or blog. Try it now! Click this link to go to your conversation:" +
                          "\n" +
                          url +
                          "\n" +
                          "\n" +
                          "With gratitude,\n" +
                          "\n" +
                          "The team at pol.is\n"
                      ).catch(function (err: any) {
                        console.error(err);
                      });
                    })
                    .catch(function (err: any) {
                      yell("polis_err_sending_conversation_created_email");
                      winston.log("info", err);
                    });
                }

                if (req.p.launch_presentation_return_url_hex) {
                  // using links because iframes are pretty crappy within Canvas assignments.
                  let linkText = "pol.is conversation";
                  if (req.p.topic) {
                    linkText += " (" + req.p.topic + ")";
                  }
                  let linkTitle = "";
                  if (req.p.description) {
                    linkTitle += req.p.description;
                  }
                  conv.lti_redirect = {
                    return_type: "url",
                    launch_presentation_return_url: hexToStr(
                      req.p.launch_presentation_return_url_hex
                    ),
                    url:
                      getServerNameWithProtocol(req) +
                      "/" +
                      req.p.conversation_id,
                    text: linkText,
                    title: linkTitle,
                    target: "_blank", // Open in a new window.
                  };
                }

                if (req.p.custom_canvas_assignment_id) {
                  addCanvasAssignmentConversationInfoIfNeeded(
                    req.p.zid,
                    req.p.tool_consumer_instance_guid,
                    req.p.context, // lti_context_id,
                    req.p.custom_canvas_assignment_id
                  )
                    .then(function () {
                      finishOne(res, conv, true, successCode);
                    })
                    .catch(function (err: any) {
                      fail(
                        res,
                        500,
                        "polis_err_saving_assignment_grading_context",
                        err
                      );
                      emailBadProblemTime(
                        "PUT conversation worked, but couldn't save assignment context"
                      );
                    });
                } else {
                  finishOne(res, conv, true, successCode);
                }

                updateConversationModifiedTime(req.p.zid);
              })
              .catch(function (err: any) {
                fail(res, 500, "polis_err_update_conversation", err);
              });
          });
        },
        function (err: { message: any }) {
          fail(res, 500, err.message, err);
        }
      );
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_update_conversation", err);
    });
}

function handle_DELETE_metadata_questions(
  req: { p: { uid?: any; pmqid: any } },
  res: { send: (arg0: number) => void }
) {
  const uid = req.p.uid;
  const pmqid = req.p.pmqid;

  getZidForQuestion(pmqid, function (err: any, zid: any) {
    if (err) {
      fail(
        res,
        500,
        "polis_err_delete_participant_metadata_questions_zid",
        err
      );
      return;
    }
    isConversationOwner(zid, uid, function (err: any) {
      if (err) {
        fail(
          res,
          403,
          "polis_err_delete_participant_metadata_questions_auth",
          err
        );
        return;
      }

      deleteMetadataQuestionAndAnswers(pmqid, function (err?: string | null) {
        if (err) {
          fail(
            res,
            500,
            "polis_err_delete_participant_metadata_question",
            new Error(err)
          );
          return;
        }
        res.send(200);
      });
    });
  });
}

function handle_DELETE_metadata_answers(
  req: { p: { uid?: any; pmaid: any } },
  res: { send: (arg0: number) => void }
) {
  const uid = req.p.uid;
  const pmaid = req.p.pmaid;

  getZidForAnswer(pmaid, function (err: any, zid: any) {
    if (err) {
      fail(
        res,
        500,
        "polis_err_delete_participant_metadata_answers_zid",
        err
      );
      return;
    }
    isConversationOwner(zid, uid, function (err: any) {
      if (err) {
        fail(
          res,
          403,
          "polis_err_delete_participant_metadata_answers_auth",
          err
        );
        return;
      }

      deleteMetadataAnswer(pmaid, function (err: any) {
        if (err) {
          fail(
            res,
            500,
            "polis_err_delete_participant_metadata_answers",
            err
          );
          return;
        }
        res.send(200);
      });
    });
  });
}

function getZidForAnswer(
  pmaid: any,
  callback: {
    (err: any, zid: any): void;
    (arg0: string | null, arg1?: undefined): void;
  }
) {
  pgQuery(
    "SELECT zid FROM participant_metadata_answers WHERE pmaid = ($1);",
    [pmaid],
    function (err: any, result: { rows: string | any[] }) {
      if (err) {
        callback(err);
        return;
      }
      if (!result.rows || !result.rows.length) {
        callback("polis_err_zid_missing_for_answer");
        return;
      }
      callback(null, result.rows[0].zid);
    }
  );
}

function getZidForQuestion(
  pmqid: any,
  callback: {
    (err: any, zid?: any): void;
    (arg0: string | null, arg1: undefined): void;
  }
) {
  pgQuery(
    "SELECT zid FROM participant_metadata_questions WHERE pmqid = ($1);",
    [pmqid],
    function (err: any, result: { rows: string | any[] }) {
      if (err) {
        winston.log("info", err);
        callback(err);
        return;
      }
      if (!result.rows || !result.rows.length) {
        callback("polis_err_zid_missing_for_question");
        return;
      }
      callback(null, result.rows[0].zid);
    }
  );
}

function deleteMetadataAnswer(
  pmaid: any,
  callback: { (err: any): void; (arg0: null): void }
) {
  pgQuery(
    "update participant_metadata_answers set alive = FALSE where pmaid = ($1);",
    [pmaid],
    function (err: any) {
      if (err) {
        callback(err);
        return;
      }
      callback(null);
    }
  );
  // });
}

function deleteMetadataQuestionAndAnswers(
  pmqid: any,
  callback: { (err: any): void; (arg0: null): void }
) {
  pgQuery(
    "update participant_metadata_answers set alive = FALSE where pmqid = ($1);",
    [pmqid],
    function (err: any) {
      if (err) {
        callback(err);
        return;
      }
      pgQuery(
        "update participant_metadata_questions set alive = FALSE where pmqid = ($1);",
        [pmqid],
        function (err: any) {
          if (err) {
            callback(err);
            return;
          }
          callback(null);
        }
      );
    }
  );
  // });
}

function handle_GET_metadata_questions(
  req: { p: { zid: any; zinvite: any; suzinvite: any } },
  res: any
) {
  const zid = req.p.zid;
  const zinvite = req.p.zinvite;
  const suzinvite = req.p.suzinvite;

  function doneChecking(err: boolean, foo?: undefined) {
    if (err) {
      fail(res, 403, "polis_err_get_participant_metadata_auth", err);
      return;
    }

    async.parallel(
      [
        function (callback: any) {
          pgQuery_readOnly(
            "SELECT * FROM participant_metadata_questions WHERE alive = true AND zid = ($1);",
            [zid],
            callback
          );
        },
      ],
      function (err: any, result: { rows: any }[]) {
        if (err) {
          fail(res, 500, "polis_err_get_participant_metadata_questions", err);
          return;
        }
        let rows = result[0] && result[0].rows;
        rows = rows.map(function (r: { required: boolean }) {
          r.required = true;
          return r;
        });
        finishArray(res, rows);
      }
    );
  }

  if (zinvite) {
    checkZinviteCodeValidity(zid, zinvite, doneChecking);
  } else if (suzinvite) {
    checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
  } else {
    doneChecking(false);
  }
}

function handle_POST_metadata_questions(
  req: { p: { zid: any; key: any; uid?: any } },
  res: any
) {
  const zid = req.p.zid;
  const key = req.p.key;
  const uid = req.p.uid;

  function doneChecking(err: any, foo?: any) {
    if (err) {
      fail(res, 403, "polis_err_post_participant_metadata_auth", err);
      return;
    }
    pgQuery(
      "INSERT INTO participant_metadata_questions (pmqid, zid, key) VALUES (default, $1, $2) RETURNING *;",
      [zid, key],
      function (err: any, results: { rows: string | any[] }) {
        if (err || !results || !results.rows || !results.rows.length) {
          fail(res, 500, "polis_err_post_participant_metadata_key", err);
          return;
        }

        finishOne(res, results.rows[0]);
      }
    );
  }

  isConversationOwner(zid, uid, doneChecking);
}

function handle_POST_metadata_answers(
  req: { p: { zid: any; uid?: any; pmqid: any; value: any } },
  res: any
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const pmqid = req.p.pmqid;
  const value = req.p.value;

  function doneChecking(err: any, foo?: any) {
    if (err) {
      fail(res, 403, "polis_err_post_participant_metadata_auth", err);
      return;
    }
    pgQuery(
      "INSERT INTO participant_metadata_answers (pmqid, zid, value, pmaid) VALUES ($1, $2, $3, default) RETURNING *;",
      [pmqid, zid, value],
      function (err: any, results: { rows: string | any[] }) {
        if (err || !results || !results.rows || !results.rows.length) {
          pgQuery(
            "UPDATE participant_metadata_answers set alive = TRUE where pmqid = ($1) AND zid = ($2) AND value = ($3) RETURNING *;",
            [pmqid, zid, value],
            function (err: any, results: { rows: any[] }) {
              if (err) {
                fail(
                  res,
                  500,
                  "polis_err_post_participant_metadata_value",
                  err
                );
                return;
              }
              finishOne(res, results.rows[0]);
            }
          );
        } else {
          finishOne(res, results.rows[0]);
        }
      }
    );
  }

  isConversationOwner(zid, uid, doneChecking);
}

function handle_GET_metadata_choices(req: { p: { zid: any } }, res: any) {
  const zid = req.p.zid;

  getChoicesForConversation(zid).then(
    function (choices: any) {
      finishArray(res, choices);
    },
    function (err: any) {
      fail(res, 500, "polis_err_get_participant_metadata_choices", err);
    }
  );
}

function handle_GET_metadata_answers(
  req: { p: { zid: any; zinvite: any; suzinvite: any; pmqid: any } },
  res: any
) {
  const zid = req.p.zid;
  const zinvite = req.p.zinvite;
  const suzinvite = req.p.suzinvite;
  const pmqid = req.p.pmqid;

  function doneChecking(err: boolean, foo?: undefined) {
    if (err) {
      fail(res, 403, "polis_err_get_participant_metadata_auth", err);
      return;
    }
    let query = sql_participant_metadata_answers
      .select(sql_participant_metadata_answers.star())
      .where(sql_participant_metadata_answers.zid.equals(zid))
      .and(sql_participant_metadata_answers.alive.equals(true));

    if (pmqid) {
      query = query.where(
        sql_participant_metadata_answers.pmqid.equals(pmqid)
      );
    }
    pgQuery_readOnly(
      query.toString(),
      function (err: any, result: { rows: any[] }) {
        if (err) {
          fail(res, 500, "polis_err_get_participant_metadata_answers", err);
          return;
        }
        const rows = result.rows.map(function (r: { is_exclusive: boolean }) {
          r.is_exclusive = true; // TODO fetch this info from the queston itself
          return r;
        });
        finishArray(res, rows);
      }
    );
  }

  if (zinvite) {
    checkZinviteCodeValidity(zid, zinvite, doneChecking);
  } else if (suzinvite) {
    checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
  } else {
    doneChecking(false);
  }
}

function handle_GET_metadata(
  req: { p: { zid: any; zinvite: any; suzinvite: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: {
        (arg0: { kvp?: {}; keys?: {}; values?: {} }): void;
        new (): any;
      };
    };
  }
) {
  const zid = req.p.zid;
  const zinvite = req.p.zinvite;
  const suzinvite = req.p.suzinvite;

  function doneChecking(err: boolean) {
    if (err) {
      fail(res, 403, "polis_err_get_participant_metadata_auth", err);
      return;
    }

    async.parallel(
      [
        function (callback: any) {
          pgQuery_readOnly(
            "SELECT * FROM participant_metadata_questions WHERE zid = ($1);",
            [zid],
            callback
          );
        },
        function (callback: any) {
          pgQuery_readOnly(
            "SELECT * FROM participant_metadata_answers WHERE zid = ($1);",
            [zid],
            callback
          );
        },
        function (callback: any) {
          pgQuery_readOnly(
            "SELECT * FROM participant_metadata_choices WHERE zid = ($1);",
            [zid],
            callback
          );
        },
      ],
      function (err: any, result: { rows: any }[]) {
        if (err) {
          fail(res, 500, "polis_err_get_participant_metadata", err);
          return;
        }
        const keys = result[0] && result[0].rows;
        const vals = result[1] && result[1].rows;
        const choices = result[2] && result[2].rows;
        const o = {};
        const keyNames = {};
        const valueNames = {};
        let i;
        let k;
        let v;
        if (!keys || !keys.length) {
          res.status(200).json({});
          return;
        }
        for (i = 0; i < keys.length; i++) {
          // Add a map for each keyId
          k = keys[i];
          o[k.pmqid] = {};
          // keep the user-facing key name
          keyNames[k.pmqid] = k.key;
        }
        for (i = 0; i < vals.length; i++) {
          // Add an array for each possible valueId
          k = vals[i];
          v = vals[i];
          o[k.pmqid][v.pmaid] = [];
          // keep the user-facing value string
          valueNames[v.pmaid] = v.value;
        }
        for (i = 0; i < choices.length; i++) {
          // Append a pid for each person who has seleted that value for that key.
          o[choices[i].pmqid][choices[i].pmaid] = choices[i].pid;
        }
        // TODO cache
        res.status(200).json({
          kvp: o, // key_id => value_id => [pid]
          keys: keyNames,
          values: valueNames,
        });
      }
    );
  }

  if (zinvite) {
    checkZinviteCodeValidity(zid, zinvite, doneChecking);
  } else if (suzinvite) {
    checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
  } else {
    doneChecking(false);
  }
}

function getConversationHasMetadata(zid: any) {
  return new Promise(function (
    resolve: (arg0: boolean) => void,
    reject: (arg0: string) => any
  ) {
    pgQuery_readOnly(
      "SELECT * from participant_metadata_questions where zid = ($1)",
      [zid],
      function (err: any, metadataResults: { rows: string | any[] }) {
        if (err) {
          return reject("polis_err_get_conversation_metadata_by_zid");
        }
        const hasNoMetadata =
          !metadataResults ||
          !metadataResults.rows ||
          !metadataResults.rows.length;
        resolve(!hasNoMetadata);
      }
    );
  });
}

function getConversationTranslations(zid: any, lang: string) {
  const firstTwoCharsOfLang = lang.substr(0, 2);
  return pgQueryP(
    "select * from conversation_translations where zid = ($1) and lang = ($2);",
    [zid, firstTwoCharsOfLang]
  );
}

function getConversationTranslationsMinimal(zid: any, lang: any) {
  if (!lang) {
    return Promise.resolve([]);
  }
  return getConversationTranslations(zid, lang).then(function (
    rows: string | any[]
  ) {
    for (let i = 0; i < rows.length; i++) {
      delete rows[i].zid;
      delete rows[i].created;
      delete rows[i].modified;
      delete rows[i].src;
    }
    return rows;
  });
}

function getOneConversation(zid: any, uid?: any, lang?: null) {
  return Promise.all([
    pgQueryP_readOnly(
      "select * from conversations left join  (select uid, site_id, plan from users) as u on conversations.owner = u.uid where conversations.zid = ($1);",
      [zid]
    ),
    getConversationHasMetadata(zid),
    _.isUndefined(uid) ? Promise.resolve({}) : getUserInfoForUid2(uid),
    getConversationTranslationsMinimal(zid, lang),
  ]).then(function (results: any[]) {
    const conv = results[0] && results[0][0];
    const convHasMetadata = results[1];
    const requestingUserInfo = results[2];
    const translations = results[3];

    conv.auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(
      conv.auth_opt_allow_3rdparty,
      true
    );
    conv.auth_opt_fb_computed =
      conv.auth_opt_allow_3rdparty &&
      ifDefinedFirstElseSecond(conv.auth_opt_fb, true);
    conv.auth_opt_tw_computed =
      conv.auth_opt_allow_3rdparty &&
      ifDefinedFirstElseSecond(conv.auth_opt_tw, true);

    conv.translations = translations;

    return getUserInfoForUid2(conv.owner).then(function (ownerInfo: {
      hname: any;
    }) {
      const ownername = ownerInfo.hname;
      if (convHasMetadata) {
        conv.hasMetadata = true;
      }
      if (!_.isUndefined(ownername) && conv.context !== "hongkong2014") {
        conv.ownername = ownername;
      }
      conv.is_mod = conv.site_id === requestingUserInfo.site_id;
      conv.is_owner = conv.owner === uid;
      conv.pp = false; // participant pays (WIP)
      delete conv.uid; // conv.owner is what you want, uid shouldn't be returned.
      return conv;
    });
  });
}

function getConversations(
  req: {
    p: ConversationType;
  },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;
  const xid = req.p.xid;
  const include_all_conversations_i_am_in =
    req.p.include_all_conversations_i_am_in;
  const want_mod_url = req.p.want_mod_url;
  const want_upvoted = req.p.want_upvoted;
  const want_inbox_item_admin_url = req.p.want_inbox_item_admin_url;
  const want_inbox_item_participant_url = req.p.want_inbox_item_participant_url;
  const want_inbox_item_admin_html = req.p.want_inbox_item_admin_html;
  const want_inbox_item_participant_html =
    req.p.want_inbox_item_participant_html;
  const context = req.p.context;
  winston.log("info", "thecontext", context);

  // include conversations started by people with the same site_id as me
  // 1's indicate that the conversations are there for that reason
  let zidListQuery =
    "select zid, 1 as type from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($1)))";
  if (include_all_conversations_i_am_in) {
    zidListQuery +=
    // using UNION ALL instead of UNION to ensure we get all the 1's and 2's (I'm not sure if we can guarantee
    // the 2's won't clobber some 1's if we use UNION)
      " UNION ALL select zid, 2 as type from participants where uid = ($1)";
  }
  zidListQuery += ";";
  pgQuery_readOnly(
    zidListQuery,
    [uid],
    function (err: any, results: { rows: any }) {
      if (err) {
        fail(res, 500, "polis_err_get_conversations_participated_in", err);
        return;
      }

      const participantInOrSiteAdminOf =
        (results && results.rows && _.pluck(results.rows, "zid")) || null;
      const siteAdminOf = _.filter(
        results.rows,
        function (row: { type: number }) {
          return row.type === 1;
        }
      );
      const isSiteAdmin = _.indexBy(siteAdminOf, "zid");

      let query = sql_conversations.select(sql_conversations.star());

      let isRootsQuery = false;
      let orClauses;
      if (!_.isUndefined(req.p.context)) {
        if (req.p.context === "/") {
          winston.log("info", "asdf" + req.p.context + "asdf");
          // root of roots returns all public conversations
          // TODO lots of work to decide what's relevant
          // There is a bit of mess here, because we're returning both public 'roots' conversations, and potentially
          // private conversations that you are already in.
          orClauses = sql_conversations.is_public.equals(true);
          isRootsQuery = true; // more conditions follow in the ANDs below
        } else {
          // knowing a context grants access to those conversations (for now at least)
          winston.log("info", "CONTEXT", context);
          orClauses = sql_conversations.context.equals(req.p.context);
        }
      } else {
        orClauses = sql_conversations.owner.equals(uid);
        if (participantInOrSiteAdminOf.length) {
          orClauses = orClauses.or(
            sql_conversations.zid.in(participantInOrSiteAdminOf)
          );
        }
      }
      query = query.where(orClauses);
      if (!_.isUndefined(req.p.course_invite)) {
        query = query.and(
          sql_conversations.course_id.equals(req.p.course_id)
        );
      }
      if (!_.isUndefined(req.p.is_active)) {
        query = query.and(
          sql_conversations.is_active.equals(req.p.is_active)
        );
      }
      if (!_.isUndefined(req.p.is_draft)) {
        query = query.and(sql_conversations.is_draft.equals(req.p.is_draft));
      }
      if (!_.isUndefined(req.p.zid)) {
        query = query.and(sql_conversations.zid.equals(zid));
      }
      if (isRootsQuery) {
        query = query.and(sql_conversations.context.isNotNull());
      }

      query = query.order(sql_conversations.created.descending);

      if (!_.isUndefined(req.p.limit)) {
        query = query.limit(req.p.limit);
      } else {
        query = query.limit(999); // TODO paginate
      }
      pgQuery_readOnly(
        query.toString(),
        function (err: any, result: { rows: never[] }) {
          if (err) {
            fail(res, 500, "polis_err_get_conversations", err);
            return;
          }
          const data = result.rows || [];
          addConversationIds(data)
            .then(function (data: any[]) {
              let suurlsPromise;
              if (xid) {
                suurlsPromise = Promise.all(
                  data.map(function (conv: { zid: any; owner: any }) {
                    return createOneSuzinvite(
                      xid,
                      conv.zid,
                      conv.owner, // TODO think: conv.owner or uid?
                      _.partial(generateSingleUseUrl, req)
                    );
                  })
                );
              } else {
                suurlsPromise = Promise.resolve();
              }
              const upvotesPromise =
                uid && want_upvoted
                  ? pgQueryP_readOnly(
                      "select zid from upvotes where uid = ($1);",
                      [uid]
                    )
                  : Promise.resolve();

              return Promise.all([suurlsPromise, upvotesPromise]).then(
                function (x: any[]) {
                  let suurlData = x[0];
                  let upvotes = x[1];
                  if (suurlData) {
                    suurlData = _.indexBy(suurlData, "zid");
                  }
                  if (upvotes) {
                    upvotes = _.indexBy(upvotes, "zid");
                  }
                  data.forEach(function (conv: {
                    is_owner: boolean;
                    owner: any;
                    mod_url: string;
                    conversation_id: string;
                    inbox_item_admin_url: string;
                    inbox_item_participant_url: string;
                    inbox_item_admin_html: string;
                    topic: string;
                    created: string | number | Date;
                    inbox_item_admin_html_escaped: any;
                    inbox_item_participant_html: string;
                    inbox_item_participant_html_escaped: any;
                    url: string;
                    upvoted: boolean;
                    modified: number;
                    is_mod: any;
                    is_anon: any;
                    is_active: any;
                    is_draft: any;
                    is_public: any;
                    zid?: string | number;
                    context?: string;
                  }) {
                    conv.is_owner = conv.owner === uid;
                    const root = getServerNameWithProtocol(req);

                    if (want_mod_url) {
                      // TODO make this into a moderation invite URL so others can join Issue #618
                      conv.mod_url = createModerationUrl(
                        req,
                        conv.conversation_id
                      );
                    }
                    if (want_inbox_item_admin_url) {
                      conv.inbox_item_admin_url =
                        root + "/iim/" + conv.conversation_id;
                    }
                    if (want_inbox_item_participant_url) {
                      conv.inbox_item_participant_url =
                        root + "/iip/" + conv.conversation_id;
                    }
                    if (want_inbox_item_admin_html) {
                      conv.inbox_item_admin_html =
                        "<a href='" +
                        root +
                        "/" +
                        conv.conversation_id +
                        "'>" +
                        (conv.topic || conv.created) +
                        "</a>" +
                        " <a href='" +
                        root +
                        "/m/" +
                        conv.conversation_id +
                        "'>moderate</a>";

                      conv.inbox_item_admin_html_escaped = conv.inbox_item_admin_html.replace(
                        /'/g,
                        "\\'"
                      );
                    }
                    if (want_inbox_item_participant_html) {
                      conv.inbox_item_participant_html =
                        "<a href='" +
                        root +
                        "/" +
                        conv.conversation_id +
                        "'>" +
                        (conv.topic || conv.created) +
                        "</a>";
                      conv.inbox_item_participant_html_escaped = conv.inbox_item_admin_html.replace(
                        /'/g,
                        "\\'"
                      );
                    }

                    if (suurlData) {
                      conv.url = suurlData[conv.zid || ""].suurl;
                    } else {
                      conv.url = buildConversationUrl(
                        req,
                        conv.conversation_id
                      );
                    }
                    if (upvotes && upvotes[conv.zid || ""]) {
                      conv.upvoted = true;
                    }
                    conv.created = Number(conv.created);
                    conv.modified = Number(conv.modified);

                    // if there is no topic, provide a UTC timstamp instead
                    if (_.isUndefined(conv.topic) || conv.topic === "") {
                      conv.topic = new Date(conv.created).toUTCString();
                    }

                    conv.is_mod =
                      conv.is_owner || isSiteAdmin[conv.zid || ""];

                    // Make sure zid is not exposed
                    delete conv.zid;

                    delete conv.is_anon;
                    delete conv.is_active;
                    delete conv.is_draft;
                    delete conv.is_public;
                    if (conv.context === "") {
                      delete conv.context;
                    }
                  });

                  res.status(200).json(data);
                },
                function (err: any) {
                  fail(res, 500, "polis_err_get_conversations_surls", err);
                }
              );
            })
            .catch(function (err: any) {
              fail(res, 500, "polis_err_get_conversations_misc", err);
            });
        }
      );
    }
  );
}

function createReport(zid: any) {
  return generateTokenP(20, false).then(function (report_id: string) {
    report_id = "r" + report_id;
    return pgQueryP("insert into reports (zid, report_id) values ($1, $2);", [
      zid,
      report_id,
    ]);
  });
}

function handle_POST_reports(
  req: { p: { zid: any; uid?: any } },
  res: { json: (arg0: {}) => void }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;

  return (
    isModerator(zid, uid)
      .then((isMod: any, err: string) => {
        if (!isMod) {
          return fail(res, 403, "polis_err_post_reports_permissions", err);
        }
        return createReport(zid).then(() => {
          res.json({});
        });
      })
      .catch((err: any) => {
        fail(res, 500, "polis_err_post_reports_misc", err);
      })
  );
}

function handle_PUT_reports(
  req: {
    p: { [x: string]: any; rid: any; uid?: any; zid: any; report_name: any };
  },
  res: { json: (arg0: {}) => void }
) {
  const rid = req.p.rid;
  const uid = req.p.uid;
  const zid = req.p.zid;

  return (
    isModerator(zid, uid)
      .then((isMod: any, err: string) => {
        if (!isMod) {
          return fail(res, 403, "polis_err_put_reports_permissions", err);
        }

        const fields: { [key: string]: string } = {
          modified: "now_as_millis()",
        };

        sql_reports.columns
          .map((c: { name: any }) => {
            return c.name;
          })
          .filter((name: string) => {
            // only allow changing label fields, (label_x_neg, etc) not zid, etc.
            return name.startsWith("label_");
          })
          .forEach((name: string | number) => {
            if (!_.isUndefined(req.p[name])) {
              fields[name] = req.p[name];
            }
          });

        if (!_.isUndefined(req.p.report_name)) {
          fields.report_name = req.p.report_name;
        }

        const q = sql_reports.update(fields).where(sql_reports.rid.equals(rid));

        let query = q.toString();
        query = query.replace("'now_as_millis()'", "now_as_millis()"); // remove quotes added by sql lib

        return pgQueryP(query, []).then((result: any) => {
          res.json({});
        });
      })
      .catch((err: any) => {
        fail(res, 500, "polis_err_post_reports_misc", err);
      })
  );
}

function handle_GET_reports(
  req: { p: { zid: any; rid: any; uid?: any } },
  res: { json: (arg0: any) => void }
) {
  const zid = req.p.zid;
  const rid = req.p.rid;
  const uid = req.p.uid;

  let reportsPromise = null;

  if (rid) {
    if (zid) {
      reportsPromise = Promise.reject(
        "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id"
      );
    } else {
      reportsPromise = pgQueryP("select * from reports where rid = ($1);", [
        rid,
      ]);
    }
  } else if (zid) {
    reportsPromise = isModerator(zid, uid).then(
      (doesOwnConversation: any) => {
        if (!doesOwnConversation) {
          throw "polis_err_permissions";
        }
        return pgQueryP("select * from reports where zid = ($1);", [zid]);
      }
    );
  } else {
    reportsPromise = pgQueryP(
      "select * from reports where zid in (select zid from conversations where owner = ($1));",
      [uid]
    );
  }

  reportsPromise
    .then((reports: any[]) => {
      const zids: any[] = [];
      reports = reports.map((report: { zid: any; rid: any }) => {
        zids.push(report.zid);
        delete report.rid;
        return report;
      });

      if (zids.length === 0) {
        return res.json(reports);
      }
      return pgQueryP(
        "select * from zinvites where zid in (" + zids.join(",") + ");",
        []
      ).then((zinvite_entries: any) => {
        const zidToZinvite = _.indexBy(zinvite_entries, "zid");
        reports = reports.map(
          (report: { conversation_id: any; zid?: string | number }) => {
            report.conversation_id = zidToZinvite[report.zid || ""]?.zinvite;
            delete report.zid;
            return report;
          }
        );
        res.json(reports);
      });
    })
    .catch((err: string) => {
      if (err === "polis_err_permissions") {
        fail(res, 403, "polis_err_permissions");
      } else if (
        err ===
        "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id"
      ) {
        fail(
          res,
          404,
          "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id"
        );
      } else {
        fail(res, 500, "polis_err_get_reports_misc", err);
      }
    });
}

function encodeParams(o: {
  monthly?: any;
  forceEmbedded?: boolean;
  xPolisLti?: any;
  tool_consumer_instance_guid?: any;
  context?: any;
  custom_canvas_assignment_id?: any;
}) {
  const stringifiedJson = JSON.stringify(o);
  const encoded = "ep1_" + strToHex(stringifiedJson);
  return encoded;
}

function handle_GET_conversations(
  req: {
    p: ConversationType;
  },
  res: any
) {
  let courseIdPromise = Promise.resolve();
  if (req.p.course_invite) {
    courseIdPromise = pgQueryP_readOnly(
      "select course_id from courses where course_invite = ($1);",
      [req.p.course_invite]
    ).then(function (rows: { course_id: any }[]) {
      return rows[0].course_id;
    });
  }
  courseIdPromise.then(function (course_id: any) {
    if (course_id) {
      req.p.course_id = course_id;
    }
    const lang = null; // for now just return the default
    if (req.p.zid) {
      getOneConversation(req.p.zid, req.p.uid, lang)
        .then(
          function (data: any) {
            finishOne(res, data);
          },
          function (err: any) {
            fail(res, 500, "polis_err_get_conversations_2", err);
          }
        )
        .catch(function (err: any) {
          fail(res, 500, "polis_err_get_conversations_1", err);
        });
    } else if (req.p.uid || req.p.context) {
      getConversations(req, res);
    } else {
      fail(res, 403, "polis_err_need_auth");
    }
  });
}

function handle_GET_contexts(
  req: any,
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  pgQueryP_readOnly(
    "select name from contexts where is_public = TRUE order by name;",
    []
  )
    .then(
      function (contexts: any) {
        res.status(200).json(contexts);
      },
      function (err: any) {
        fail(res, 500, "polis_err_get_contexts_query", err);
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_get_contexts_misc", err);
    });
}

function handle_POST_contexts(
  req: { p: { uid?: any; name: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const uid = req.p.uid;
  const name = req.p.name;

  function createContext() {
    return pgQueryP(
      "insert into contexts (name, creator, is_public) values ($1, $2, $3);",
      [name, uid, true]
    )
      .then(
        function () {
          res.status(200).json({});
        },
        function (err: any) {
          fail(res, 500, "polis_err_post_contexts_query", err);
        }
      )
      .catch(function (err: any) {
        fail(res, 500, "polis_err_post_contexts_misc", err);
      });
  }
  pgQueryP("select name from contexts where name = ($1);", [name])
    .then(
      function (rows: string | any[]) {
        const exists = rows && rows.length;
        if (exists) {
          fail(res, 422, "polis_err_post_context_exists");
          return;
        }
        return createContext();
      },
      function (err: any) {
        fail(res, 500, "polis_err_post_contexts_check_query", err);
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_post_contexts_check_misc", err);
    });
}

function isUserAllowedToCreateConversations(
  uid?: any,
  callback?: {
    (err: any, isAllowed: any): void;
    (err: any, isAllowed: any): void;
    (arg0: null, arg1: boolean): void;
  }
) {
  callback?.(null, true);
}

function handle_POST_reserve_conversation_id(
  req: any,
  res: { json: (arg0: { conversation_id: any }) => void }
) {
  const zid = 0;
  const shortUrl = false;
  // TODO check auth - maybe bot has key
  generateAndRegisterZinvite(zid, shortUrl)
    .then(function (conversation_id: any) {
      res.json({
        conversation_id: conversation_id,
      });
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_reserve_conversation_id", err);
    });
}

function handle_POST_conversations(
  req: {
    p: {
      context: any;
      short_url: any;
      uid?: any;
      org_id: any;
      topic: any;
      description: any;
      is_active: any;
      is_data_open: any;
      is_draft: any;
      is_anon: any;
      profanity_filter: any;
      spam_filter: any;
      strict_moderation: any;
      owner_sees_participation_stats: any;
      auth_needed_to_vote: any;
      auth_needed_to_write: any;
      auth_opt_allow_3rdparty: any;
      auth_opt_fb: any;
      auth_opt_tw: any;
      conversation_id: any;
    };
  },
  res: any
) {
  const xidStuffReady = Promise.resolve();

  xidStuffReady
    .then(() => {
      winston.log("info", "context", req.p.context);
      const generateShortUrl = req.p.short_url;

      isUserAllowedToCreateConversations(
        req.p.uid,
        function (err: any, isAllowed: any) {
          if (err) {
            fail(
              res,
              403,
              "polis_err_add_conversation_failed_user_check",
              err
            );
            return;
          }
          if (!isAllowed) {
            fail(
              res,
              403,
              "polis_err_add_conversation_not_enabled",
              new Error("polis_err_add_conversation_not_enabled")
            );
            return;
          }
          const q = sql_conversations
            .insert({
              owner: req.p.uid, // creator
              // assume the owner is the creator if there's no separate owner specified (
              org_id: req.p.org_id || req.p.uid,
              topic: req.p.topic,
              description: req.p.description,
              is_active: req.p.is_active,
              is_data_open: req.p.is_data_open,
              is_draft: req.p.is_draft,
              is_public: true, // req.p.short_url,
              is_anon: req.p.is_anon,
              profanity_filter: req.p.profanity_filter,
              spam_filter: req.p.spam_filter,
              strict_moderation: req.p.strict_moderation,
              context: req.p.context || null,
              owner_sees_participation_stats: !!req.p
                .owner_sees_participation_stats,
              // Set defaults for fields that aren't set at postgres level.
              auth_needed_to_vote:
                req.p.auth_needed_to_vote || DEFAULTS.auth_needed_to_vote,
              auth_needed_to_write:
                req.p.auth_needed_to_write || DEFAULTS.auth_needed_to_write,
              auth_opt_allow_3rdparty:
                req.p.auth_opt_allow_3rdparty ||
                DEFAULTS.auth_opt_allow_3rdparty,
              auth_opt_fb: req.p.auth_opt_fb || DEFAULTS.auth_opt_fb,
              auth_opt_tw: req.p.auth_opt_tw || DEFAULTS.auth_opt_tw,
            })
            .returning("*")
            .toString();

          pgQuery(
            q,
            [],
            function (err: any, result: { rows: { zid: any }[] }) {
              if (err) {
                if (isDuplicateKey(err)) {
                  yell(err);
                  failWithRetryRequest(res);
                } else {
                  fail(res, 500, "polis_err_add_conversation", err);
                }
                return;
              }

              const zid =
                result && result.rows && result.rows[0] && result.rows[0].zid;

              const zinvitePromise = req.p.conversation_id
                ? Conversation.getZidFromConversationId(
                    req.p.conversation_id
                  ).then((zid: number) => {
                    return zid === 0 ? req.p.conversation_id : null;
                  })
                : generateAndRegisterZinvite(zid, generateShortUrl);

              zinvitePromise
                .then(function (zinvite: null) {
                  if (zinvite === null) {
                    fail(
                      res,
                      400,
                      "polis_err_conversation_id_already_in_use",
                      err
                    );
                    return;
                  }
                  // NOTE: OK to return conversation_id, because this conversation was just created by this user.
                  finishOne(res, {
                    url: buildConversationUrl(req, zinvite),
                    zid: zid,
                  });
                })
                .catch(function (err: any) {
                  fail(res, 500, "polis_err_zinvite_create", err);
                });
            }
          );
        }
      );
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_conversation_create", err);
    });
}

function handle_POST_query_participants_by_metadata(
  req: { p: { uid?: any; zid: any; pmaids: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: never[]): void; new (): any };
    };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;
  const pmaids = req.p.pmaids;

  if (!pmaids.length) {
    // empty selection
    return res.status(200).json([]);
  }

  function doneChecking() {
    // find list of participants who are not eliminated by the list of excluded choices.
    pgQuery_readOnly(
      // 3. invert the selection of participants, so we get those who passed the filter.
      "select pid from participants where zid = ($1) and pid not in " +
        // 2. find the people who chose those answers
        "(select pid from participant_metadata_choices where alive = TRUE and pmaid in " +
        // 1. find the unchecked answers
        "(select pmaid from participant_metadata_answers where alive = TRUE and zid = ($2) and pmaid not in (" +
        pmaids.join(",") +
        "))" +
        ")" +
        ";",
      [zid, zid],
      function (err: any, results: { rows: any }) {
        if (err) {
          fail(res, 500, "polis_err_metadata_query", err);
          return;
        }
        res.status(200).json(_.pluck(results.rows, "pid"));
      }
    );
  }

  isOwnerOrParticipant(zid, uid, doneChecking);
}

function handle_POST_sendCreatedLinkToEmail(
  req: { p: { uid?: any; zid: string } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  winston.log("info", req.p);
  pgQuery_readOnly(
    "SELECT * FROM users WHERE uid = $1",
    [req.p.uid],
    function (err: any, results: { rows: UserType[] }) {
      if (err) {
        fail(res, 500, "polis_err_get_email_db", err);
        return;
      }
      const email = results.rows[0].email;
      const fullname = results.rows[0].hname;
      pgQuery_readOnly(
        "select * from zinvites where zid = $1",
        [req.p.zid],
        function (err: any, results: { rows: { zinvite: any }[] }) {
          const zinvite = results.rows[0].zinvite;
          const server = getServerNameWithProtocol(req);
          const createdLink = server + "/#" + req.p.zid + "/" + zinvite;
          const body =
            "" +
            "Hi " +
            fullname +
            ",\n" +
            "\n" +
            "Here's a link to the conversation you just created. Use it to invite participants to the conversation. Share it by whatever network you prefer - Gmail, Facebook, Twitter, etc., or just post it to your website or blog. Try it now! Click this link to go to your conversation: \n" +
            "\n" +
            createdLink +
            "\n" +
            "\n" +
            "With gratitude,\n" +
            "\n" +
            "The team at pol.is";

          return sendTextEmail(
            polisFromAddress,
            email,
            "Link: " + createdLink,
            body
          )
            .then(function () {
              res.status(200).json({});
            })
            .catch(function (err: any) {
              fail(res, 500, "polis_err_sending_created_link_to_email", err);
            });
        }
      );
    }
  );
}

function handle_POST_notifyTeam(
  req: {
    p: {
      webserver_pass: string | undefined;
      webserver_username: string | undefined;
      subject: any;
      body: any;
    };
  },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  if (
    req.p.webserver_pass !== Config.webserverPass ||
    req.p.webserver_username !== Config.webserverUsername
  ) {
    return fail(res, 403, "polis_err_notifyTeam_auth");
  }
  const subject = req.p.subject;
  const body = req.p.body;
  emailTeam(subject, body)
    .then(() => {
      res.status(200).json({});
    })
    .catch((err: any) => {
      return fail(res, 500, "polis_err_notifyTeam");
    });
}

// Email.handlePostSendEmailExportReady;

// Twitter;

function switchToUser(req: any, res: any, uid?: any) {
  return new Promise(function (
    resolve: () => void,
    reject: (arg0: string) => void
  ) {
    startSession(uid, function (errSess: any, token: any) {
      if (errSess) {
        reject(errSess);
        return;
      }
      addCookies(req, res, token, uid)
        .then(function () {
          resolve();
        })
        .catch(function (err: any) {
          reject("polis_err_adding_cookies");
        });
    });
  });
}

// retry, resolving with first success, or rejecting with final error
function retryFunctionWithPromise(
  f: { (): any; (): Promise<any> },
  numTries: number
) {
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: any) => void
  ) {
    winston.log("info", "retryFunctionWithPromise", numTries);
    f().then(
      function (x: any) {
        winston.log("info", "retryFunctionWithPromise", "RESOLVED");
        resolve(x);
      },
      function (err: any) {
        numTries -= 1;
        if (numTries <= 0) {
          winston.log("info", "retryFunctionWithPromise", "REJECTED");
          reject(err);
        } else {
          retryFunctionWithPromise(f, numTries).then(resolve, reject);
        }
      }
    );
  });
}

function addParticipant(zid: any, uid?: any) {
  return pgQueryP(
    "INSERT INTO participants_extended (zid, uid) VALUES ($1, $2);",
    [zid, uid]
  ).then(() => {
    return pgQueryP(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING *;",
      [zid, uid]
    );
  });
}

function getSocialParticipantsForMod_timed(
  zid?: any,
  limit?: any,
  mod?: any,
  convOwner?: any
) {
  const start = Date.now();
  return getSocialParticipantsForMod
    .apply(null, [zid, limit, mod, convOwner])
    .then(function (results: any) {
      const elapsed = Date.now() - start;
      console.log("getSocialParticipantsForMod_timed", elapsed);
      return results;
    });
}

function getSocialParticipantsForMod(
  zid: any,
  limit: any,
  mod: any,
  owner: any
) {
  let modClause = "";
  const params = [zid, limit, owner];
  if (!_.isUndefined(mod)) {
    modClause = " and mod = ($4)";
    params.push(mod);
  }

  const q =
    "with " +
    "p as (select uid, pid, mod from participants where zid = ($1) " +
    modClause +
    "), " + // and vote_count >= 1
    "final_set as (select * from p limit ($2)), " +
    "xids_subset as (select * from xids where owner = ($3) and x_profile_image_url is not null), " +
    "all_rows as (select " +
    "final_set.mod, " +
    "twitter_users.twitter_user_id as tw__twitter_user_id, " +
    "twitter_users.screen_name as tw__screen_name, " +
    "twitter_users.name as tw__name, " +
    "twitter_users.followers_count as tw__followers_count, " +
    "twitter_users.verified as tw__verified, " +
    "twitter_users.profile_image_url_https as tw__profile_image_url_https, " +
    "twitter_users.location as tw__location, " +
    "facebook_users.fb_user_id as fb__fb_user_id, " +
    "facebook_users.fb_name as fb__fb_name, " +
    "facebook_users.fb_link as fb__fb_link, " +
    "facebook_users.fb_public_profile as fb__fb_public_profile, " +
    "facebook_users.location as fb__location, " +
    "xids_subset.x_profile_image_url as x_profile_image_url, " +
    "xids_subset.xid as xid, " +
    "xids_subset.x_name as x_name, " +

    "final_set.pid " +
    "from final_set " +
    "left join twitter_users on final_set.uid = twitter_users.uid " +
    "left join facebook_users on final_set.uid = facebook_users.uid " +
    "left join xids_subset on final_set.uid = xids_subset.uid " +
    ") " +
    "select * from all_rows where (tw__twitter_user_id is not null) or (fb__fb_user_id is not null) or (xid is not null) " +
    ";";
  return pgQueryP(q, params);
}

const socialParticipantsCache = new LruCache({
  maxAge: 1000 * 30, // 30 seconds
  max: 999,
});

function getSocialParticipants(
  zid: any,
  uid?: any,
  limit?: any,
  mod?: number,
  math_tick?: any,
  authorUids?: any[]
) {
  // NOTE ignoring authorUids as part of cacheKey for now, just because.
  const cacheKey = [zid, limit, mod, math_tick].join("_");
  if (socialParticipantsCache.get(cacheKey)) {
    return socialParticipantsCache.get(cacheKey);
  }

  const authorsQueryParts = (authorUids || []).map(function (
    authoruid?: any
  ) {
    // TODO investigate this one.
    // TODO looks like a possible typo bug
    return "select " + Number(authorUid) + " as uid, 900 as priority";
  });
  let authorsQuery: string | null =
    "(" + authorsQueryParts.join(" union ") + ")";
  if (!authorUids || authorUids.length === 0) {
    authorsQuery = null;
  }

  const q =
    "with " +
    "p as (select uid, pid, mod from participants where zid = ($1) and vote_count >= 1), " +
    // "all_friends as (select  " +
    //         "friend as uid, 100 as priority from facebook_friends where uid = ($2) " +
    //         "union  " +
    //         "select uid, 100 as priority from facebook_friends where friend = ($2)), " +

    "xids_subset as (select * from xids where owner in (select org_id from conversations where zid = ($1)) and x_profile_image_url is not null), " +
    "xid_ptpts as (select p.uid, 100 as priority from p inner join xids_subset on xids_subset.uid = p.uid where p.mod >= ($4)), " +
    "twitter_ptpts as (select p.uid, 10 as priority from p inner join twitter_users  on twitter_users.uid  = p.uid where p.mod >= ($4)), " +
    "all_fb_users as (select p.uid,   9 as priority from p inner join facebook_users on facebook_users.uid = p.uid where p.mod >= ($4)), " +
    "self as (select CAST($2 as INTEGER) as uid, 1000 as priority), " +
    (authorsQuery ? "authors as " + authorsQuery + ", " : "") +
    "pptpts as (select prioritized_ptpts.uid, max(prioritized_ptpts.priority) as priority " +
    "from ( " +
    "select * from self " +
    (authorsQuery ? "union " + "select * from authors " : "") +
    "union " +
    "select * from twitter_ptpts " +
    "union " +
    "select * from all_fb_users " +
    "union " +
    "select * from xid_ptpts " +
    ") as prioritized_ptpts " +
    "inner join p on prioritized_ptpts.uid = p.uid " +
    "group by prioritized_ptpts.uid order by priority desc, prioritized_ptpts.uid asc), " +
    // force inclusion of participants with high mod values
    "mod_pptpts as (select asdfasdjfioasjdfoi.uid, max(asdfasdjfioasjdfoi.priority) as priority " +
    "from ( " +
    "select * from pptpts " +
    "union all " +
    "select uid, 999 as priority from p where mod >= 2) as asdfasdjfioasjdfoi " +
    "group by asdfasdjfioasjdfoi.uid order by priority desc, asdfasdjfioasjdfoi.uid asc), " +

    // without blocked
    "final_set as (select * from mod_pptpts " +
    "limit ($3) " +
    ") " + // in invisible_uids
    "select " +
    "final_set.priority, " +
    "twitter_users.twitter_user_id as tw__twitter_user_id, " +
    "twitter_users.screen_name as tw__screen_name, " +
    "twitter_users.name as tw__name, " +
    "twitter_users.followers_count as tw__followers_count, " +
    "twitter_users.verified as tw__verified, " +
    "twitter_users.location as tw__location, " +
    "facebook_users.fb_user_id as fb__fb_user_id, " +
    "facebook_users.fb_name as fb__fb_name, " +
    "facebook_users.fb_link as fb__fb_link, " +
    "facebook_users.fb_public_profile as fb__fb_public_profile, " +
    "facebook_users.location as fb__location, " +
    "xids_subset.x_profile_image_url as x_profile_image_url, " +
    "xids_subset.xid as xid, " +
    "xids_subset.x_name as x_name, " +
    "xids_subset.x_email as x_email, " +
    "p.pid " +
    "from final_set " +
    "left join twitter_users on final_set.uid = twitter_users.uid " +
    "left join facebook_users on final_set.uid = facebook_users.uid " +
    "left join xids_subset on final_set.uid = xids_subset.uid " +
    "left join p on final_set.uid = p.uid " +
    ";";

  return pgQueryP_metered_readOnly("getSocialParticipants", q, [
    zid,
    uid,
    limit,
    mod,
  ]).then(function (response: any) {
    console.log("getSocialParticipants", response);
    socialParticipantsCache.set(cacheKey, response);
    return response;
  });
}

const getSocialInfoForUsers = User.getSocialInfoForUsers;

function updateVoteCount(zid: any, pid: any) {
  // return pgQueryP("update participants set vote_count = vote_count + 1 where zid = ($1) and pid = ($2);",[zid, pid]);
  return pgQueryP(
    "update participants set vote_count = (select count(*) from votes where zid = ($1) and pid = ($2)) where zid = ($1) and pid = ($2)",
    [zid, pid]
  );
}

// zid_pid => "math_tick:ppaddddaadadaduuuuuuuuuuuuuuuuu"; // not using objects to save some ram
// TODO consider "p2a24a2dadadu15" format
const votesForZidPidCache = new LruCache({
  max: 5000,
});

function getVotesForZidPidWithTimestampCheck(
  zid: string,
  pid: string,
  math_tick: number
) {
  const key = zid + "_" + pid;
  const cachedVotes = votesForZidPidCache.get(key);
  if (cachedVotes) {
    const pair = cachedVotes.split(":");
    const cachedTime = Number(pair[0]);
    const votes = pair[1];
    if (cachedTime >= math_tick) {
      return votes;
    }
  }
  return null;
}

function cacheVotesForZidPidWithTimestamp(
  zid: string,
  pid: string,
  math_tick: string,
  votes: string
) {
  const key = zid + "_" + pid;
  const val = math_tick + ":" + votes;
  votesForZidPidCache.set(key, val);
}

// returns {pid -> "adadddadpupuuuuuuuu"}
function getVotesForZidPidsWithTimestampCheck(
  zid: any,
  pids: any[],
  math_tick: any
) {
  let cachedVotes = pids.map(function (pid: any) {
    return {
      pid: pid,
      votes: getVotesForZidPidWithTimestampCheck(zid, pid, math_tick),
    };
  });
  const uncachedPids = cachedVotes
    .filter(function (o: { votes: any }) {
      return !o.votes;
    })
    .map(function (o: { pid: any }) {
      return o.pid;
    });
  cachedVotes = cachedVotes.filter(function (o: { votes: any }) {
    return !!o.votes;
  });

  function toObj(items: string | any[]) {
    const o = {};
    for (let i = 0; i < items.length; i++) {
      o[items[i].pid] = items[i].votes;
    }
    return o;
  }

  if (uncachedPids.length === 0) {
    return Promise.resolve(toObj(cachedVotes));
  }
  return getVotesForPids(zid, uncachedPids).then(function (votesRows: any) {
    const newPidToVotes = aggregateVotesToPidVotesObj(votesRows);
    _.each(newPidToVotes, function (votes: any, pid: any) {
      cacheVotesForZidPidWithTimestamp(zid, pid, math_tick, votes);
    });
    const cachedPidToVotes = toObj(cachedVotes);
    return Object.assign(newPidToVotes, cachedPidToVotes);
  });
}

function getVotesForPids(zid: any, pids: any[]) {
  if (pids.length === 0) {
    return Promise.resolve([]);
  }
  return (
    pgQueryP_readOnly(
      "select * from votes where zid = ($1) and pid in (" +
        pids.join(",") +
        ") order by pid, tid, created;",
      [zid]
    )
      .then(function (votesRows: string | any[]) {
        for (let i = 0; i < votesRows.length; i++) {
          votesRows[i].weight = votesRows[i].weight / 32767;
        }
        return votesRows;
      })
  );
}

function createEmptyVoteVector(greatestTid: number) {
  const a = [];
  for (let i = 0; i <= greatestTid; i++) {
    a[i] = "u"; // (u)nseen
  }
  return a;
}

function aggregateVotesToPidVotesObj(votes: string | any[]) {
  let i = 0;
  let greatestTid = 0;
  for (i = 0; i < votes.length; i++) {
    if (votes[i].tid > greatestTid) {
      greatestTid = votes[i].tid;
    }
  }

  // use arrays or strings?
  const vectors = {}; // pid -> sparse array
  for (i = 0; i < votes.length; i++) {
    const v = votes[i];
    // set up a vector for the participant, if not there already
    vectors[v.pid] = vectors[v.pid] || createEmptyVoteVector(greatestTid);
    // assign a vote value at that location
    const vote = v.vote;
    if (polisTypes.reactions.push === vote) {
      vectors[v.pid][v.tid] = "d";
    } else if (polisTypes.reactions.pull === vote) {
      vectors[v.pid][v.tid] = "a";
    } else if (polisTypes.reactions.pass === vote) {
      vectors[v.pid][v.tid] = "p";
    } else {
      console.error("unknown vote value");
      // let it stay 'u'
    }
  }
  const vectors2: { [key: string]: any } = {};
  _.each(vectors, function (val: any[], key: string) {
    vectors2[key] = val.join("");
  });
  return vectors2;
}

function getLocationsForParticipants(zid: any) {
  return pgQueryP_readOnly(
    "select * from participant_locations where zid = ($1);",
    [zid]
  );
}

function getPidsForGid(zid: any, gid: number, math_tick: number) {
  return Promise.all([
    getPca(zid, math_tick),
    getBidIndexToPidMapping(zid, math_tick),
  ]).then(function (o: ParticipantOption[]) {
    if (!o[0] || !o[0].asPOJO) {
      return [];
    }
    o[0] = o[0].asPOJO;
    const clusters = o[0]["group-clusters"];
    const indexToBid = o[0]["base-clusters"].id; // index to bid
    const bidToIndex = [];
    for (let i = 0; i < indexToBid.length; i++) {
      bidToIndex[indexToBid[i]] = i;
    }
    const indexToPids = o[1].bidToPid; // actually index to [pid]
    const cluster = clusters[gid];
    if (!cluster) {
      return [];
    }
    const members = cluster.members; // bids
    let pids: any[] = [];
    for (let i = 0; i < members.length; i++) {
      const bid = members[i];
      const index = bidToIndex[bid];
      const morePids = indexToPids[index];
      Array.prototype.push.apply(pids, morePids);
    }
    pids = pids.map(function (x) {
      return parseInt(x);
    });
    pids.sort(function (a, b) {
      return a - b;
    });
    return pids;
  });
}

function geoCodeWithGoogleApi(locationString: string) {
  const googleApiKey = process.env.GOOGLE_API_KEY;
  const address = encodeURI(locationString);

  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: string) => void
  ) {
    request
      .get(
        "https://maps.googleapis.com/maps/api/geocode/json?address=" +
          address +
          "&key=" +
          googleApiKey
      )
      .then(function (response: any) {
        response = JSON.parse(response);
        if (response.status !== "OK") {
          reject("polis_err_geocoding_failed");
          return;
        }
        // NOTE: seems like there could be multiple responses - using first for now
        const bestResult = response.results[0];
        resolve(bestResult);
      }, reject)
      .catch(reject);
  });
}

function geoCode(locationString: any) {
  return (
    pgQueryP("select * from geolocation_cache where location = ($1);", [
      locationString,
    ])
      .then(function (rows: string | any[]) {
        if (!rows || !rows.length) {
          return geoCodeWithGoogleApi(locationString).then(function (result: {
            geometry: { location: { lat: any; lng: any } };
          }) {
            winston.log("info", result);
            const lat = result.geometry.location.lat;
            const lng = result.geometry.location.lng;
            // NOTE: not waiting for the response to this - it might fail in the case of a race-condition, since we don't have upsert
            pgQueryP(
              "insert into geolocation_cache (location,lat,lng,response) values ($1,$2,$3,$4);",
              [locationString, lat, lng, JSON.stringify(result)]
            );
            const o = {
              lat: lat,
              lng: lng,
            };
            return o;
          });
        } else {
          const o = {
            lat: rows[0].lat,
            lng: rows[0].lng,
          };
          return o;
        }
      })
  );
}

const twitterShareCountCache = LruCache({
  maxAge: 1000 * 60 * 30, // 30 minutes
  max: 999,
});

function getTwitterShareCountForConversation(conversation_id: string) {
  const cached = twitterShareCountCache.get(conversation_id);
  if (cached) {
    return Promise.resolve(cached);
  }
  const httpUrl =
    "https://cdn.api.twitter.com/1/urls/count.json?url=http://pol.is/" +
    conversation_id;
  const httpsUrl =
    "https://cdn.api.twitter.com/1/urls/count.json?url=https://pol.is/" +
    conversation_id;
  return Promise.all([request.get(httpUrl), request.get(httpsUrl)]).then(
    function (a: any[]) {
      const httpResult = a[0];
      const httpsResult = a[1];
      const httpCount = JSON.parse(httpResult).count;
      const httpsCount = JSON.parse(httpsResult).count;
      if (httpCount > 0 && httpsCount > 0 && httpCount === httpsCount) {
        console.warn(
          "found matching http and https twitter share counts, if this is common, check twitter api to see if it has changed."
        );
      }
      const count = httpCount + httpsCount;
      twitterShareCountCache.set(conversation_id, count);
      return count;
    }
  );
}

const fbShareCountCache = LruCache({
  maxAge: 1000 * 60 * 30, // 30 minutes
  max: 999,
});

function getFacebookShareCountForConversation(conversation_id: string) {
  const cached = fbShareCountCache.get(conversation_id);
  if (cached) {
    return Promise.resolve(cached);
  }
  const url = "http://graph.facebook.com/?id=https://pol.is/" + conversation_id;
  return request.get(url).then(function (result: string) {
    const shares = JSON.parse(result).shares;
    fbShareCountCache.set(conversation_id, shares);
    return shares;
  });
}

function getParticipantDemographicsForConversation(zid: any) {
  return pgQueryP(
    "select * from demographic_data left join participants on participants.uid = demographic_data.uid where zid = ($1);",
    [zid]
  );
}

function getParticipantVotesForCommentsFlaggedWith_is_meta(zid: any) {
  return pgQueryP(
    "select tid, pid, vote from votes_latest_unique where zid = ($1) and tid in (select tid from comments where zid = ($1) and is_meta = true)",
    [zid]
  );
}

function handle_GET_groupDemographics(
  req: { p: { zid: any; uid?: any; rid: any } },
  res: {
    json: (
      arg0: {
        gid: number;
        count: number;
        // convenient counts
        gender_male: number;
        gender_female: number;
        gender_null: number;
        birth_year: number;
        birth_year_count: number;
        meta_comment_agrees: {};
        meta_comment_disagrees: {};
        meta_comment_passes: {};
      }[]
    ) => void;
  }
) {
  const zid = req.p.zid;
  Promise.all([
    getPidsForGid(zid, 0, -1),
    getPidsForGid(zid, 1, -1),
    getPidsForGid(zid, 2, -1),
    getPidsForGid(zid, 3, -1),
    getPidsForGid(zid, 4, -1),
    getParticipantDemographicsForConversation(zid),
    getParticipantVotesForCommentsFlaggedWith_is_meta(zid),
    isModerator(req.p.zid, req.p.uid),
  ])
    .then((o: any[]) => {
      const groupPids = [];
      const groupStats = [];

      let meta = o[5];
      const metaVotes = o[6];
      const isMod = o[7];

      const isReportQuery = !_.isUndefined(req.p.rid);

      if (!isMod && !isReportQuery) {
        throw "polis_err_groupDemographics_auth";
      }

      for (let i = 0; i < 5; i++) {
        if (o[i] && o[i].length) {
          groupPids.push(o[i]);

          groupStats.push({
            gid: i,
            count: 0,

            // convenient counts
            gender_male: 0,
            gender_female: 0,
            gender_null: 0,
            birth_year: 0,
            birth_year_count: 0,

            meta_comment_agrees: {},
            meta_comment_disagrees: {},
            meta_comment_passes: {},
          });
        } else {
          break;
        }
      }
      meta = _.indexBy(meta, "pid");
      const pidToMetaVotes = _.groupBy(metaVotes, "pid");

      for (let i = 0; i < groupStats.length; i++) {
        const s: DemographicEntry = groupStats[i];
        const pids = groupPids[i];
        for (let p = 0; p < pids.length; p++) {
          const pid = pids[p];
          const ptptMeta = meta[pid];
          if (ptptMeta) {
            s.count += 1;

            // compute convenient counts
            let gender = null;
            if (_.isNumber(ptptMeta.fb_gender)) {
              gender = ptptMeta.fb_gender;
            } else if (_.isNumber(ptptMeta.gender_guess)) {
              gender = ptptMeta.gender_guess;
            } else if (_.isNumber(ptptMeta.ms_gender_estimate_fb)) {
              gender = ptptMeta.ms_gender_estimate_fb;
            }
            if (gender === 0) {
              s.gender_male += 1;
            } else if (gender === 1) {
              s.gender_female += 1;
            } else {
              s.gender_null += 1;
            }
            let birthYear = null;
            if (ptptMeta.ms_birth_year_estimate_fb > 1900) {
              birthYear = ptptMeta.ms_birth_year_estimate_fb;
            } else if (ptptMeta.birth_year_guess > 1900) {
              birthYear = ptptMeta.birth_year_guess;
            }
            if (birthYear > 1900) {
              s.birth_year += birthYear;
              s.birth_year_count += 1;
            }
          }
          const ptptMetaVotes = pidToMetaVotes[pid];
          if (ptptMetaVotes) {
            for (let v = 0; v < ptptMetaVotes.length; v++) {
              const vote = ptptMetaVotes[v];
              if (vote.vote === polisTypes.reactions.pass) {
                s.meta_comment_passes[vote.tid] =
                  1 + (s.meta_comment_passes[vote.tid] || 0);
              } else if (vote.vote === polisTypes.reactions.pull) {
                s.meta_comment_agrees[vote.tid] =
                  1 + (s.meta_comment_agrees[vote.tid] || 0);
              } else if (vote.vote === polisTypes.reactions.push) {
                s.meta_comment_disagrees[vote.tid] =
                  1 + (s.meta_comment_disagrees[vote.tid] || 0);
              }
            }
          }
        }
        s.ms_birth_year_estimate_fb =
          s.ms_birth_year_estimate_fb / s.ms_birth_year_count;
        s.birth_year_guess = s.birth_year_guess / s.birth_year_guess_count;
        s.birth_year = s.birth_year / s.birth_year_count;
      }

      res.json(groupStats);
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_groupDemographics", err);
    });
}

// this is for testing the encryption
function handle_GET_logMaxmindResponse(
  req: { p: { uid?: any; zid: any; user_uid?: any } },
  res: { json: (arg0: {}) => void }
) {
  if (!isPolisDev(req.p.uid) || !devMode) {
    // TODO fix this by piping the error from the usage of this in ./app
    return fail(res, 403, "polis_err_permissions", err);
  }
  pgQueryP(
    "select * from participants_extended where zid = ($1) and uid = ($2);",
    [req.p.zid, req.p.user_uid]
  )
    .then((results: string | any[]) => {
      if (!results || !results.length) {
        res.json({});
        console.log("NOTHING");
        return;
      }
      const o = results[0];
      _.each(o, (val: any, key: string) => {
        if (key.startsWith("encrypted_")) {
          o[key] = decrypt(val);
        }
      });
      console.log(o);
      res.json({});
    })
    .catch((err: any) => {
      fail(res, 500, "polis_err_get_participantsExtended", err);
    });
}

function handle_GET_locations(
  req: { p: { zid: any; gid: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const zid = req.p.zid;
  const gid = req.p.gid;

  Promise.all([getPidsForGid(zid, gid, -1), getLocationsForParticipants(zid)])
    .then(function (o: any[]) {
      const pids = o[0];
      let locations = o[1];
      locations = locations.filter(function (locData: { pid: any }) {
        const pidIsInGroup = _.indexOf(pids, locData.pid, true) >= 0; // uses binary search
        return pidIsInGroup;
      });
      locations = locations.map(function (locData: { lat: any; lng: any }) {
        return {
          lat: locData.lat,
          lng: locData.lng,
          n: 1,
        };
      });
      res.status(200).json(locations);
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_locations_01", err);
    });
}

function removeNullOrUndefinedProperties(o: { [x: string]: any }) {
  for (const k in o) {
    const v = o[k];
    if (v === null || v === undefined) {
      delete o[k];
    }
  }
  return o;
}

function pullXInfoIntoSubObjects(ptptoiRecord: any) {
  const p = ptptoiRecord;
  if (p.x_profile_image_url || p.xid || p.x_email) {
    p.xInfo = {};
    p.xInfo.x_profile_image_url = p.x_profile_image_url;
    p.xInfo.xid = p.xid;
    p.xInfo.x_name = p.x_name;
    // p.xInfo.x_email = p.x_email;
    delete p.x_profile_image_url;
    delete p.xid;
    delete p.x_name;
    delete p.x_email;
  }
  return p;
}

function pullFbTwIntoSubObjects(ptptoiRecord: any) {
  const p = ptptoiRecord;
  const x: ParticipantSocialNetworkInfo = {};
  _.each(p, function (val: null, key: string) {
    const fbMatch = /fb__(.*)/.exec(key);
    const twMatch = /tw__(.*)/.exec(key);
    if (fbMatch && fbMatch.length === 2 && val !== null) {
      x.facebook = x.facebook || {};
      x.facebook[fbMatch[1]] = val;
    } else if (twMatch && twMatch.length === 2 && val !== null) {
      x.twitter = x.twitter || {};
      x.twitter[twMatch[1]] = val;
    } else {
      x[key] = val;
    }
  });
  // extract props from fb_public_profile
  if (x.facebook && x.facebook.fb_public_profile) {
    try {
      const temp = JSON.parse(x.facebook.fb_public_profile);
      x.facebook.verified = temp.verified;
      // shouln't return this to client
      delete x.facebook.fb_public_profile;
    } catch (e) {
      console.error(
        "error parsing JSON of fb_public_profile for uid: ",
        p.uid
      );
    }

    if (!_.isUndefined(x.facebook.fb_user_id)) {
      const width = 40;
      const height = 40;
      x.facebook.fb_picture =
        "https://graph.facebook.com/v2.2/" +
        x.facebook.fb_user_id +
        "/picture?width=" +
        width +
        "&height=" +
        height;
    }
  }
  return x;
}

function handle_PUT_ptptois(
  req: { p: { zid: any; uid?: any; pid: any; mod: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const pid = req.p.pid;
  const mod = req.p.mod;
  isModerator(zid, uid)
    .then(function (isMod: any) {
      if (!isMod) {
        fail(res, 403, "polis_err_ptptoi_permissions_123");
        return;
      }
      return pgQueryP(
        "update participants set mod = ($3) where zid = ($1) and pid = ($2);",
        [zid, pid, mod]
      ).then(function () {
        res.status(200).json({});
      });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_ptptoi_misc_234", err);
    });
}

function handle_GET_ptptois(
  req: { p: { zid: any; mod: any; uid?: any; conversation_id: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const zid = req.p.zid;
  const mod = req.p.mod;
  const uid = req.p.uid;
  const limit = 99999;

  const convPromise = getConversationInfo(req.p.zid);
  const socialPtptsPromise = convPromise.then((conv: { owner: any }) => {
    return getSocialParticipantsForMod_timed(zid, limit, mod, conv.owner);
  });

  Promise.all([socialPtptsPromise, getConversationInfo(zid)])
    .then(function (a: any[]) {
      let ptptois = a[0];
      const conv = a[1];
      const isOwner = uid === conv.owner;
      const isAllowed = isOwner || isPolisDev(req.p.uid) || conv.is_data_open;
      if (isAllowed) {
        ptptois = ptptois.map(pullXInfoIntoSubObjects);
        ptptois = ptptois.map(removeNullOrUndefinedProperties);
        ptptois = ptptois.map(pullFbTwIntoSubObjects);
        ptptois = ptptois.map(function (p: { conversation_id: any }) {
          p.conversation_id = req.p.conversation_id;
          return p;
        });
      } else {
        ptptois = [];
      }
      res.status(200).json(ptptois);
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_ptptoi_misc", err);
    });
}

function handle_GET_votes_famous(
  req: { p: any },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  doFamousQuery(req.p, req)
    .then(
      function (data: any) {
        res.status(200).json(data);
      },
      function (err: any) {
        fail(res, 500, "polis_err_famous_proj_get2", err);
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_famous_proj_get1", err);
    });
}

function doFamousQuery(
  o?: { uid?: any; zid: any; math_tick: any; ptptoiLimit: any },
  req?: any
) {
  const uid = o?.uid;
  const zid = o?.zid;
  const math_tick = o?.math_tick;

  // NOTE: if this API is running slow, it's probably because fetching the PCA from pg is slow, and PCA caching is disabled

  // let twitterLimit = 999; // we can actually check a lot of these, since they might be among the fb users
  // let softLimit = 26;
  const hardLimit = _.isUndefined(o?.ptptoiLimit) ? 30 : o?.ptptoiLimit;
  // let ALLOW_NON_FRIENDS_WHEN_EMPTY_SOCIAL_RESULT = true;
  // for now, assume all conversations will show unmoderated and approved participants.
  const mod = 0;

  function getAuthorUidsOfFeaturedComments() {
    return getPca(zid, 0).then(function (pcaData: {
      asPOJO: any;
      consensus: { agree?: any; disagree?: any };
      repness: { [x: string]: any };
    }) {
      if (!pcaData) {
        return [];
      }
      pcaData = pcaData.asPOJO;
      pcaData.consensus = pcaData.consensus || {};
      pcaData.consensus.agree = pcaData.consensus.agree || [];
      pcaData.consensus.disagree = pcaData.consensus.disagree || [];
      const consensusTids = _.union(
        _.pluck(pcaData.consensus.agree, "tid"),
        _.pluck(pcaData.consensus.disagree, "tid")
      );

      let groupTids: never[] = [];
      for (const gid in pcaData.repness) {
        const commentData = pcaData.repness[gid];
        groupTids = _.union(groupTids, _.pluck(commentData, "tid"));
      }
      let featuredTids = _.union(consensusTids, groupTids);
      featuredTids.sort();
      featuredTids = _.uniq(featuredTids);

      if (featuredTids.length === 0) {
        return [];
      }
      const q =
        "with " +
        "authors as (select distinct(uid) from comments where zid = ($1) and tid in (" +
        featuredTids.join(",") +
        ") order by uid) " +
        "select authors.uid from authors inner join facebook_users on facebook_users.uid = authors.uid " +
        "union " +
        "select authors.uid from authors inner join twitter_users on twitter_users.uid = authors.uid " +
        "union " +
        "select authors.uid from authors inner join xids on xids.uid = authors.uid " +
        "order by uid;";

      return pgQueryP_readOnly(q, [zid]).then(function (comments: any) {
        let uids = _.pluck(comments, "uid");
        console.log("famous uids", uids);

        uids = _.uniq(uids);
        return uids;
      });
    });
  }
  return Promise.all([
    getConversationInfo(zid),
    getAuthorUidsOfFeaturedComments(),
  ]).then(function (a: any[]) {
    const conv = a[0];
    const authorUids = a[1];

    if (conv.is_anon) {
      return {};
    }

    return Promise.all([
      getSocialParticipants(zid, uid, hardLimit, mod, math_tick, authorUids),
    ]).then(function (stuff: never[][]) {

      let participantsWithSocialInfo: any[] = stuff[0] || [];
      // TODO There are issues with this:
      //   really, the data should all be merged first, then the list should be truncated to the correct number.
      // ALSO, we could return data on everyone who might appear in the list view, and add an "importance" score to
      // help determine who to show in the vis at various screen sizes. (a client determination)
      // ALSO, per-group-minimums: we should include at least a facebook friend and at least one famous twitter
      // user(if they exist) per group

      participantsWithSocialInfo = participantsWithSocialInfo.map(
        function (p: { priority: number }) {
          let x = pullXInfoIntoSubObjects(p);
          // nest the fb and tw properties in sub objects
          x = pullFbTwIntoSubObjects(x);

          if (p.priority === 1000) {
            x.isSelf = true;
          }
          if (x.twitter) {
            x.twitter.profile_image_url_https =
              getServerNameWithProtocol(req) +
              "/twitter_image?id=" +
              x.twitter.twitter_user_id;
          }
          return x;
        }
      );

      let pids = participantsWithSocialInfo.map(function (p: { pid: any }) {
        return p.pid;
      });
      console.log("mike1234", pids.length);

      const pidToData = _.indexBy(participantsWithSocialInfo, "pid"); // TODO this is extra work, probably not needed after some rethinking
      console.log("mike12345", pidToData);

      pids.sort(function (a: number, b: number) {
        return a - b;
      });
      pids = _.uniq(pids, true);

      console.log("mike12346", pids);

      return getVotesForZidPidsWithTimestampCheck(zid, pids, math_tick).then(
        function (vectors: any) {
          // TODO parallelize with above query
          return getBidsForPids(zid, -1, pids).then(
            function (pidsToBids: { [x: string]: any }) {
              _.each(
                vectors,
                function (value: any, pid: string | number, list: any) {
                  pid = parseInt(pid as string);
                  const bid = pidsToBids[pid];
                  const notInBucket = _.isUndefined(bid);
                  const isSelf = pidToData[pid].isSelf;
                  if (notInBucket && !isSelf) {
                    console.log("mike12347", "deleting", pid);
                    // if the participant isn't in a bucket, they probably haven't voted enough for the math worker
                    // to bucketize them.
                    delete pidToData[pid];
                  } else if (pidToData[pid]) {
                    console.log("mike12348", "keeping", pid);
                    pidToData[pid].votes = value; // no separator, like this "adupuuauuauupuuu";
                    pidToData[pid].bid = bid;
                  }
                }
              );
              return pidToData;
            },
            function (err: any) {
              // looks like there is no pca yet, so nothing to return.
              return {};
            }
          );
        }
      );
    });
  });
}

function handle_GET_twitter_users(
  req: { p: { uid?: any; twitter_user_id: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const uid = req.p.uid;
  let p;
  if (uid) {
    p = pgQueryP_readOnly("select * from twitter_users where uid = ($1);", [
      uid,
    ]);
  } else if (req.p.twitter_user_id) {
    p = pgQueryP_readOnly(
      "select * from twitter_users where twitter_user_id = ($1);",
      [req.p.twitter_user_id]
    );
  } else {
    fail(res, 401, "polis_err_missing_uid_or_twitter_user_id");
    return;
  }
  p.then(function (data: any) {
    data = data[0];
    data.profile_image_url_https =
      getServerNameWithProtocol(req) +
      "/twitter_image?id=" +
      data.twitter_user_id;
    res.status(200).json(data);
  }).catch(function (err: any) {
    fail(res, 500, "polis_err_twitter_user_info_get", err);
  });
}

function doSendEinvite(req: any, email: any) {
  return generateTokenP(30, false).then(function (einvite: any) {
    return pgQueryP(
      "insert into einvites (email, einvite) values ($1, $2);",
      [email, einvite]
    ).then(function (rows: any) {
      return sendEinviteEmail(req, email, einvite);
    });
  });
}

function handle_POST_einvites(
  req: { p: { email: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  const email = req.p.email;
  doSendEinvite(req, email)
    .then(function () {
      res.status(200).json({});
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_sending_einvite", err);
    });
}

function handle_GET_einvites(
  req: { p: { einvite: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  const einvite = req.p.einvite;

  winston.log("info", "select * from einvites where einvite = ($1);", [
    einvite,
  ]);
  pgQueryP("select * from einvites where einvite = ($1);", [einvite])
    .then(function (rows: string | any[]) {
      if (!rows.length) {
        throw new Error("polis_err_missing_einvite");
      }
      res.status(200).json(rows[0]);
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_fetching_einvite", err);
    });
}

function handle_POST_contributors(
  req: {
    p: {
      uid: null;
      agreement_version: any;
      name: any;
      email: any;
      github_id: any;
      company_name: any;
    };
  },
  res: { json: (arg0: {}) => void }
) {
  const uid = req.p.uid || null;
  const agreement_version = req.p.agreement_version;
  const name = req.p.name;
  const email = req.p.email;
  const github_id = req.p.github_id;
  const company_name = req.p.company_name;

  pgQueryP(
    "insert into contributor_agreement_signatures (uid, agreement_version, github_id, name, email, company_name) " +
      "values ($1, $2, $3, $4, $5, $6);",
    [uid, agreement_version, github_id, name, email, company_name]
  ).then(
    () => {
      emailTeam(
        "contributer agreement signed",
        [uid, agreement_version, github_id, name, email, company_name].join(
          "\n"
        )
      );

      res.json({});
    },
    (err: any) => {
      fail(res, 500, "polis_err_POST_contributors_misc", err);
    }
  );
}

function generateSingleUseUrl(
  req: any,
  conversation_id: string,
  suzinvite: string
) {
  return (
    getServerNameWithProtocol(req) +
    "/ot/" +
    conversation_id +
    "/" +
    suzinvite
  );
}

function buildConversationUrl(req: any, zinvite: string | null) {
  return getServerNameWithProtocol(req) + "/" + zinvite;
}

function buildConversationDemoUrl(req: any, zinvite: string) {
  return getServerNameWithProtocol(req) + "/demo/" + zinvite;
}

function buildModerationUrl(req: any, zinvite: string) {
  return getServerNameWithProtocol(req) + "/m/" + zinvite;
}

function buildSeedUrl(req: any, zinvite: any) {
  return buildModerationUrl(req, zinvite) + "/comments/seed";
}

function getConversationUrl(req: any, zid: any, dontUseCache: boolean) {
  return getZinvite(zid, dontUseCache).then(function (zinvite: any) {
    return buildConversationUrl(req, zinvite);
  });
}

function createOneSuzinvite(
  xid: any,
  zid: any,
  owner: any,
  generateSingleUseUrl: (arg0: any, arg1: any) => any
) {
  return generateSUZinvites(1).then(function (suzinviteArray: any[]) {
    const suzinvite = suzinviteArray[0];
    return pgQueryP(
      "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES ($1, $2, $3, $4);",
      [suzinvite, xid, zid, owner]
    )
      .then(function (result: any) {
        return getZinvite(zid);
      })
      .then(function (conversation_id: any) {
        return {
          zid: zid,
          conversation_id: conversation_id,
        };
      })
      .then(function (o: { zid: any; conversation_id: any }) {
        return {
          zid: o.zid,
          conversation_id: o.conversation_id,
          suurl: generateSingleUseUrl(o.conversation_id, suzinvite),
        };
      });
  });
}

function handle_GET_setup_assignment_xml(
  req: any,
  res: {
    set: (arg0: string, arg1: string) => void;
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      send: { (arg0: string): void; new (): any };
    };
  }
) {
  const xml =
    "" +
    '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +
    "<blti:title>Polis Setup Assignment</blti:title>" +
    "<blti:description>based on Minecraft LMS integration</blti:description>" +
    "<blti:icon>" +
    "http://minecraft.inseng.net:8133/minecraft-16x16.png" +
    "</blti:icon>" +
    "<blti:launch_url>https://preprod.pol.is/api/v3/LTI/setup_assignment</blti:launch_url>" +
    "<blti:custom>" +
    '<lticm:property name="custom_canvas_xapi_url">$Canvas.xapi.url</lticm:property>' +
    "</blti:custom>" +
    '<blti:extensions platform="canvas.instructure.com">' +
    '<lticm:property name="tool_id">polis_lti</lticm:property>' +
    '<lticm:property name="privacy_level">public</lticm:property>' +
    // homework 1 (link accounts)
    // https://canvas.instructure.com/doc/api/file.homework_submission_tools.html
    '<lticm:options name="homework_submission">' +
    // This is the URL that will be POSTed to when users click the button in any rich editor.
    '<lticm:property name="url">https://preprod.pol.is/api/v3/LTI/setup_assignment</lticm:property>' +
    '<lticm:property name="icon_url">' +
    "http://minecraft.inseng.net:8133/minecraft-16x16.png" +
    "</lticm:property>" +
    '<lticm:property name="text">polis accout setup (first assignment)</lticm:property>' +
    '<lticm:property name="selection_width">400</lticm:property>' +
    '<lticm:property name="selection_height">300</lticm:property>' +
    '<lticm:property name="enabled">true</lticm:property>' +
    "</lticm:options>" +
    "</blti:extensions>" +
    '<cartridge_bundle identifierref="BLTI001_Bundle"/>' +
    '<cartridge_icon identifierref="BLTI001_Icon"/>' +
    "</cartridge_basiclti_link>";

  res.set("Content-Type", "text/xml");
  res.status(200).send(xml);
}

function handle_GET_conversation_assigmnent_xml(
  req: any,
  res: {
    set: (arg0: string, arg1: string) => void;
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      send: { (arg0: string): void; new (): any };
    };
  }
) {
  const serverName = getServerNameWithProtocol(req);

  const xml =
    "" +
    '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +
    "<blti:title>Polis Conversation Setup</blti:title>" +
    "<blti:description>Polis conversation</blti:description>" +
    "<blti:launch_url>" +
    serverName +
    "/api/v3/LTI/conversation_assignment</blti:launch_url>" +
    "<blti:custom>" +
    '<lticm:property name="custom_canvas_xapi_url">$Canvas.xapi.url</lticm:property>' +
    "</blti:custom>" +
    '<blti:extensions platform="canvas.instructure.com">' +
    '<lticm:property name="tool_id">polis_conversation_lti</lticm:property>' +
    '<lticm:property name="privacy_level">public</lticm:property>' +
    // homework 2 (polis discussions)
    // https://canvas.instructure.com/doc/api/file.homework_submission_tools.html
    '<lticm:options name="homework_submission">' +
    '<lticm:property name="url">' +
    serverName +
    "/api/v3/LTI/conversation_assignment</lticm:property>" + // ?
    '<lticm:property name="icon_url">' +
    "http://minecraft.inseng.net:8133/minecraft-16x16.png" +
    "</lticm:property>" +
    '<lticm:property name="text">polis setup</lticm:property>' +
    '<lticm:property name="selection_width">400</lticm:property>' +
    '<lticm:property name="selection_height">300</lticm:property>' +
    '<lticm:property name="enabled">true</lticm:property>' +
    "</lticm:options>" +
    "</blti:extensions>" +
    '<cartridge_bundle identifierref="BLTI001_Bundle"/>' +
    '<cartridge_icon identifierref="BLTI001_Icon"/>' +
    "</cartridge_basiclti_link>";

  res.set("Content-Type", "text/xml");
  res.status(200).send(xml);
}

function handle_GET_canvas_app_instructions_png(
  req: { headers?: { [x: string]: string } },
  res: any
) {
  let path = "/landerImages/";
  if (/Android/.exec(req?.headers?.["user-agent"] || "")) {
    path += "app_instructions_android.png";
  } else if (
    /iPhone.*like Mac OS X/.exec(req?.headers?.["user-agent"] || "")
  ) {
    path += "app_instructions_ios.png";
  } else {
    path += "app_instructions_blank.png";
  }
  const doFetch = makeFileFetcher(hostname, staticFilesClientPort, path, {
    "Content-Type": "image/png",
  });
  doFetch(req, res);
}

function handle_GET_testConnection(
  req: any,
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: { status: string }): void; new (): any };
    };
  }
) {
  res.status(200).json({
    status: "ok",
  });
}

function handle_GET_testDatabase(
  req: any,
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: { status: string }): void; new (): any };
    };
  }
) {
  pgQueryP("select uid from users limit 1", []).then(
    (rows: any) => {
      res.status(200).json({
        status: "ok",
      });
    },
    (err: any) => {
      fail(res, 500, "polis_err_testDatabase", err);
    }
  );
}

function sendSuzinviteEmail(
  req: any,
  email: any,
  conversation_id: string,
  suzinvite: string
) {
  const serverName = getServerNameWithProtocol(req);
  const body =
    "" +
    "Welcome to pol.is!\n" +
    "\n" +
    "Click this link to open your account:\n" +
    "\n" +
    serverName +
    "/ot/" +
    conversation_id +
    "/" +
    suzinvite +
    "\n" +
    "\n" +
    "Thank you for using Polis\n";

  return sendTextEmail(
    polisFromAddress,
    email,
    "Join the pol.is conversation!",
    body
  );
}

function addInviter(inviter_uid?: any, invited_email?: any) {
  return pgQueryP(
    "insert into inviters (inviter_uid, invited_email) VALUES ($1, $2);",
    [inviter_uid, invited_email]
  );
}

function handle_POST_users_invite(
  req: { p: { uid?: any; emails: any; zid: any; conversation_id: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      json: { (arg0: { status: string }): void; new (): any };
    };
  }
) {
  const uid = req.p.uid;
  const emails = req.p.emails;
  const zid = req.p.zid;
  const conversation_id = req.p.conversation_id;

  getConversationInfo(zid)
    .then(function (conv: { owner: any }) {
      const owner = conv.owner;

      // generate some tokens
      // add them to a table paired with user_ids
      // return URLs with those.
      generateSUZinvites(emails.length)
        .then(function (suzinviteArray: any) {
          const pairs = _.zip(emails, suzinviteArray);

          const valuesStatements = pairs.map(function (pair: any[]) {
            const xid = escapeLiteral(pair[0]);
            const suzinvite = escapeLiteral(pair[1]);
            const statement =
              "(" + suzinvite + ", " + xid + "," + zid + "," + owner + ")";
            winston.log("info", statement);
            return statement;
          });
          const query =
            "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES " +
            valuesStatements.join(",") +
            ";";
          winston.log("info", query);
          pgQuery(query, [], function (err: any, results: any) {
            if (err) {
              fail(res, 500, "polis_err_saving_invites", err);
              return;
            }

            Promise.all(
              pairs.map(function (pair: any[]) {
                const email = pair[0];
                const suzinvite = pair[1];
                return sendSuzinviteEmail(
                  req,
                  email,
                  conversation_id,
                  suzinvite
                ).then(
                  function () {
                    return addInviter(uid, email);
                  },
                  function (err: any) {
                    fail(res, 500, "polis_err_sending_invite", err);
                  }
                );
              })
            )
              .then(function () {
                res.status(200).json({
                  status: ":-)",
                });
              })
              .catch(function (err: any) {
                fail(res, 500, "polis_err_sending_invite", err);
              });
          });
        })
        .catch(function (err: any) {
          fail(res, 500, "polis_err_generating_invites", err);
        });
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_getting_conversation_info", err);
    });
}

function initializeImplicitConversation(
  site_id: RegExpExecArray | null,
  page_id: RegExpExecArray | null,
  o: {}
) {
  // find the user with that site_id.. wow, that will be a big index..
  // I suppose we could duplicate the site_ids that actually have conversations
  // into a separate table, and search that first, only searching users if nothing is there.
  return (
    pgQueryP_readOnly(
      "select uid from users where site_id = ($1) and site_owner = TRUE;",
      [site_id]
    )
      .then(function (rows: string | any[]) {
        if (!rows || !rows.length) {
          throw new Error("polis_err_bad_site_id");
        }
        return new Promise(function (
          resolve: (arg0: { owner: any; zid: any; zinvite: any }) => void,
          reject: (arg0: string, arg1?: undefined) => void
        ) {
          const uid = rows[0].uid;
          //    create a conversation for the owner we got,
          const generateShortUrl = false;

          isUserAllowedToCreateConversations(
            uid,
            function (err: any, isAllowed: any) {
              if (err) {
                reject(err);
                return;
              }
              if (!isAllowed) {
                reject(err);
                return;
              }

              const params = Object.assign(o, {
                owner: uid,
                org_id: uid,
                // description: req.p.description,
                is_active: true,
                is_draft: false,
                is_public: true, // TODO remove this column
                is_anon: false,
                profanity_filter: true, // TODO this could be drawn from config for the owner
                spam_filter: true, // TODO this could be drawn from config for the owner
                strict_moderation: false, // TODO this could be drawn from config for the owner
                // context: req.p.context,
                owner_sees_participation_stats: false, // TODO think, and test join
              });

              const q = sql_conversations
                .insert(params)
                .returning("*")
                .toString();

              pgQuery(
                q,
                [],
                function (err: any, result: { rows: { zid: any }[] }) {
                  if (err) {
                    if (isDuplicateKey(err)) {
                      yell(err);
                      reject("polis_err_create_implicit_conv_duplicate_key");
                    } else {
                      reject("polis_err_create_implicit_conv_db");
                    }
                  }

                  const zid =
                    result &&
                    result.rows &&
                    result.rows[0] &&
                    result.rows[0].zid;

                  Promise.all([
                    registerPageId(site_id, page_id, zid),
                    generateAndRegisterZinvite(zid, generateShortUrl),
                  ])
                    .then(function (o: any[]) {
                      // let notNeeded = o[0];
                      const zinvite = o[1];
                      // NOTE: OK to return conversation_id, because this conversation was just created by this user.
                      resolve({
                        owner: uid,
                        zid: zid,
                        zinvite: zinvite,
                      });
                    })
                    .catch(function (err: any) {
                      reject("polis_err_zinvite_create_implicit", err);
                    });
                }
              ); // end insert
            }
          ); // end isUserAllowedToCreateConversations

          //    add a record to page_ids
          //    (put the site_id in the smaller site_ids table)
          //    redirect to the zinvite url for the conversation
        });
      })
  );
}

function sendImplicitConversationCreatedEmails(
  site_id: string | RegExpExecArray | null,
  page_id: string | RegExpExecArray | null,
  url: string,
  modUrl: string,
  seedUrl: string
) {
  const body =
    "" +
    "Conversation created!" +
    "\n" +
    "\n" +
    "You can find the conversation here:\n" +
    url +
    "\n" +
    "You can moderate the conversation here:\n" +
    modUrl +
    "\n" +
    "\n" +
    'We recommend you add 2-3 short statements to start things off. These statements should be easy to agree or disagree with. Here are some examples:\n "I think the proposal is good"\n "This topic matters a lot"\n or "The bike shed should have a metal roof"\n\n' +
    "You can add statements here:\n" +
    seedUrl +
    "\n" +
    "\n" +
    "Feel free to reply to this email if you have questions." +
    "\n" +
    "\n" +
    "Additional info: \n" +
    'site_id: "' +
    site_id +
    '"\n' +
    'page_id: "' +
    page_id +
    '"\n' +
    "\n";

  return pgQueryP("select email from users where site_id = ($1)", [
    site_id,
  ]).then(function (rows: any) {
    const emails = _.pluck(rows, "email");

    return sendMultipleTextEmails(
      polisFromAddress,
      emails,
      "Polis conversation created",
      body
    );
  });
}

function registerPageId(site_id: any, page_id: any, zid: any) {
  return pgQueryP(
    "insert into page_ids (site_id, page_id, zid) values ($1, $2, $3);",
    [site_id, page_id, zid]
  );
}

function doGetConversationPreloadInfo(conversation_id: any) {
  // return Promise.resolve({});
  return Conversation.getZidFromConversationId(conversation_id)
    .then(function (zid: any) {
      return Promise.all([getConversationInfo(zid)]);
    })
    .then(function (a: any[]) {
      let conv = a[0];

      const auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(
        conv.auth_opt_allow_3rdparty,
        DEFAULTS.auth_opt_allow_3rdparty
      );
      const auth_opt_fb_computed =
        auth_opt_allow_3rdparty &&
        ifDefinedFirstElseSecond(conv.auth_opt_fb, DEFAULTS.auth_opt_fb);
      const auth_opt_tw_computed =
        auth_opt_allow_3rdparty &&
        ifDefinedFirstElseSecond(conv.auth_opt_tw, DEFAULTS.auth_opt_tw);

      conv = {
        topic: conv.topic,
        description: conv.description,
        created: conv.created,
        link_url: conv.link_url,
        parent_url: conv.parent_url,
        vis_type: conv.vis_type,
        write_type: conv.write_type,
        help_type: conv.help_type,
        socialbtn_type: conv.socialbtn_type,
        bgcolor: conv.bgcolor,
        help_color: conv.help_color,
        help_bgcolor: conv.help_bgcolor,
        style_btn: conv.style_btn,
        auth_needed_to_vote: ifDefinedFirstElseSecond(
          conv.auth_needed_to_vote,
          DEFAULTS.auth_needed_to_vote
        ),
        auth_needed_to_write: ifDefinedFirstElseSecond(
          conv.auth_needed_to_write,
          DEFAULTS.auth_needed_to_write
        ),
        auth_opt_allow_3rdparty: auth_opt_allow_3rdparty,
        auth_opt_fb_computed: auth_opt_fb_computed,
        auth_opt_tw_computed: auth_opt_tw_computed,
      };
      conv.conversation_id = conversation_id;
      // conv = Object.assign({}, optionalResults, conv);
      return conv;
    });
}

function handle_GET_conversationPreloadInfo(
  req: { p: { conversation_id: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
  }
) {
  return doGetConversationPreloadInfo(req.p.conversation_id).then(
    (conv: any) => {
      res.status(200).json(conv);
    },
    (err: any) => {
      fail(res, 500, "polis_err_get_conversation_preload_info", err);
    }
  );
}

// NOTE: this isn't optimal
// rather than code for a new URL scheme for implicit conversations,
// the idea is to redirect implicitly created conversations
// to their zinvite based URL after creating the conversation.
// To improve conversation load time, this should be changed so that it
// does not redirect, and instead serves up the index.
// The routers on client and server will need to be updated for that
// as will checks like isParticipationView on the client.
function handle_GET_implicit_conversation_generation(
  req: {
    path: string;
    p: {
      demo: any;
      ucv: any;
      ucw: any;
      ucsh: any;
      ucst: any;
      ucsd: any;
      ucsv: any;
      ucsf: any;
      ui_lang: any;
      subscribe_type: any;
      xid: any;
      x_name: any;
      x_profile_image_url: any;
      x_email: any;
      parent_url: any;
      dwok: any;
      build: any;
      show_vis: any;
      bg_white: any;
      show_share: any;
      referrer: any;
    };
    headers?: { origin: string };
  },
  res: { redirect: (arg0: string) => void }
) {
  let site_id = /polis_site_id[^\/]*/.exec(req.path) || null;
  let page_id = /\S\/([^\/]*)/.exec(req.path) || null;
  if (!site_id?.length || (page_id && page_id?.length < 2)) {
    fail(res, 404, "polis_err_parsing_site_id_or_page_id");
  }
  // TODO fix this after refactoring server.ts
  // TODO into smaller files with one function per file
  // TODO manually tracing scope is too difficult right now
  site_id = site_id?.[0];
  page_id = page_id?.[1];

  const demo = req.p.demo;
  const ucv = req.p.ucv;
  const ucw = req.p.ucw;
  const ucsh = req.p.ucsh;
  const ucst = req.p.ucst;
  const ucsd = req.p.ucsd;
  const ucsv = req.p.ucsv;
  const ucsf = req.p.ucsf;
  const ui_lang = req.p.ui_lang;
  const subscribe_type = req.p.subscribe_type;
  const xid = req.p.xid;
  const x_name = req.p.x_name;
  const x_profile_image_url = req.p.x_profile_image_url;
  const x_email = req.p.x_email;
  const parent_url = req.p.parent_url;
  const dwok = req.p.dwok;
  const build = req.p.build;
  const o: ConversationType = {};
  ifDefinedSet("parent_url", req.p, o);
  ifDefinedSet("auth_needed_to_vote", req.p, o);
  ifDefinedSet("auth_needed_to_write", req.p, o);
  ifDefinedSet("auth_opt_fb", req.p, o);
  ifDefinedSet("auth_opt_tw", req.p, o);
  ifDefinedSet("auth_opt_allow_3rdparty", req.p, o);
  ifDefinedSet("topic", req.p, o);
  if (!_.isUndefined(req.p.show_vis)) {
    o.vis_type = req.p.show_vis ? 1 : 0;
  }
  if (!_.isUndefined(req.p.bg_white)) {
    o.bgcolor = req.p.bg_white ? "#fff" : null;
  }
  o.socialbtn_type = req.p.show_share ? 1 : 0;
  // Set stuff in cookies to be retrieved when POST participants is called.
  let setOnPolisDomain = !domainOverride;
  const origin = req?.headers?.origin || "";
  if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
    setOnPolisDomain = false;
  }
  if (req.p.referrer) {
    setParentReferrerCookie(req, res, setOnPolisDomain, req.p.referrer);
  }
  if (req.p.parent_url) {
    setParentUrlCookie(req, res, setOnPolisDomain, req.p.parent_url);
  }

  function appendParams(url: string) {
    // These are needed to disambiguate postMessages from multiple polis conversations embedded on one page.
    url += "?site_id=" + site_id + "&page_id=" + page_id;
    if (!_.isUndefined(ucv)) {
      url += "&ucv=" + ucv;
    }
    if (!_.isUndefined(ucw)) {
      url += "&ucw=" + ucw;
    }
    if (!_.isUndefined(ucst)) {
      url += "&ucst=" + ucst;
    }
    if (!_.isUndefined(ucsd)) {
      url += "&ucsd=" + ucsd;
    }
    if (!_.isUndefined(ucsv)) {
      url += "&ucsv=" + ucsv;
    }
    if (!_.isUndefined(ucsf)) {
      url += "&ucsf=" + ucsf;
    }
    if (!_.isUndefined(ui_lang)) {
      url += "&ui_lang=" + ui_lang;
    }
    if (!_.isUndefined(ucsh)) {
      url += "&ucsh=" + ucsh;
    }
    if (!_.isUndefined(subscribe_type)) {
      url += "&subscribe_type=" + subscribe_type;
    }
    if (!_.isUndefined(xid)) {
      url += "&xid=" + xid;
    }
    if (!_.isUndefined(x_name)) {
      url += "&x_name=" + encodeURIComponent(x_name);
    }
    if (!_.isUndefined(x_profile_image_url)) {
      url +=
        "&x_profile_image_url=" + encodeURIComponent(x_profile_image_url);
    }
    if (!_.isUndefined(x_email)) {
      url += "&x_email=" + encodeURIComponent(x_email);
    }
    if (!_.isUndefined(parent_url)) {
      url += "&parent_url=" + encodeURIComponent(parent_url);
    }
    if (!_.isUndefined(dwok)) {
      url += "&dwok=" + dwok;
    }
    if (!_.isUndefined(build)) {
      url += "&build=" + build;
    }
    return url;
  }

  // also parse out the page_id after the '/', and look that up, along with site_id in the page_ids table
  pgQueryP_readOnly(
    "select * from page_ids where site_id = ($1) and page_id = ($2);",
    [site_id, page_id]
  )
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        // conv not initialized yet
        initializeImplicitConversation(site_id, page_id, o)
          .then(function (conv: { zinvite: any }) {
            let url = _.isUndefined(demo)
              ? buildConversationUrl(req, conv.zinvite)
              : buildConversationDemoUrl(req, conv.zinvite);
            const modUrl = buildModerationUrl(req, conv.zinvite);
            const seedUrl = buildSeedUrl(req, conv.zinvite);
            sendImplicitConversationCreatedEmails(
              site_id,
              page_id,
              url,
              modUrl,
              seedUrl
            )
              .then(function () {
                winston.log("info", "email sent");
              })
              .catch(function (err: any) {
                console.error("email fail");
                console.error(err);
              });

            url = appendParams(url);
            res.redirect(url);
          })
          .catch(function (err: any) {
            fail(res, 500, "polis_err_creating_conv", err);
          });
      } else {
        // conv was initialized, nothing to set up
        getZinvite(rows[0].zid)
          .then(function (conversation_id: any) {
            let url = buildConversationUrl(req, conversation_id);
            url = appendParams(url);
            res.redirect(url);
          })
          .catch(function (err: any) {
            fail(res, 500, "polis_err_finding_conversation_id", err);
          });
      }
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_redirecting_to_conv", err);
    });
}

const routingProxy = new httpProxy.createProxyServer();

function addStaticFileHeaders(res: {
  setHeader: (arg0: string, arg1: string | number) => void;
}) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", 0);
}

function proxy(req: { headers?: { host: string }; path: any }, res: any) {
  const hostname = buildStaticHostname(req, res);
  if (!hostname) {
    const host = req?.headers?.host || "";
    const re = new RegExp(Config.getServerHostname() + "$");
    if (host.match(re)) {
      // don't alert for this, it's probably DNS related
      // TODO_SEO what should we return?
      userFail(
        res,
        500,
        "polis_err_proxy_serving_to_domain",
        new Error(host)
      );
    } else {
      fail(res, 500, "polis_err_proxy_serving_to_domain", new Error(host));
    }
    console.error(req?.headers?.host);
    console.error(req.path);
    return;
  }

  if (devMode) {
    addStaticFileHeaders(res);
  }
  const port = Config.staticFilesClientPort;
  // set the host header too, since S3 will look at that (or the routing proxy will patch up the request.. not sure which)
  if (req && req.headers && req.headers.host) req.headers.host = hostname;
  routingProxy.web(req, res, {
    target: {
      host: hostname,
      port: port,
    },
  });
  // }
}

function buildStaticHostname(req: { headers?: { host: string } }, res: any) {
  if (devMode || domainOverride) {
    return Config.staticFilesHost;
  } else {
    let origin = req?.headers?.host;
    if (!whitelistedBuckets[origin || ""]) {
      if (hasWhitelistMatches(origin || "")) {
        // Use the prod bucket for non pol.is domains
        return whitelistedBuckets["pol.is"] + "." + Config.staticFilesHost;
      } else {
        console.error(
          "got request with host that's not whitelisted: (" +
            req?.headers?.host +
            ")"
        );
        return;
      }
    }
    origin = whitelistedBuckets[origin || ""];
    return origin + "." + Config.staticFilesHost;
  }
}

function makeRedirectorTo(path: string) {
  return function (
    req: { headers?: { host: string } },
    res: {
      writeHead: (arg0: number, arg1: { Location: string }) => void;
      end: () => void;
    }
  ) {
    const protocol = devMode ? "http://" : "https://";
    const url = protocol + req?.headers?.host + path;
    res.writeHead(302, {
      Location: url,
    });
    res.end();
  };
}

// https://github.com/mindmup/3rdpartycookiecheck/
// https://stackoverflow.com/questions/32601424/render-raw-html-in-response-with-express
function fetchThirdPartyCookieTestPt1(
  req: any,
  res: {
    set: (arg0: { "Content-Type": string }) => void;
    send: (arg0: Buffer) => void;
  }
) {
  res.set({ "Content-Type": "text/html" });
  res.send(
    new Buffer(
      "<body>\n" +
        "<script>\n" +
        '  document.cookie="thirdparty=yes; Max-Age=3600; SameSite=None; Secure";\n' +
        '  document.location="thirdPartyCookieTestPt2.html";\n' +
        "</script>\n" +
        "</body>"
    )
  );
}

function fetchThirdPartyCookieTestPt2(
  req: any,
  res: {
    set: (arg0: { "Content-Type": string }) => void;
    send: (arg0: Buffer) => void;
  }
) {
  res.set({ "Content-Type": "text/html" });
  res.send(
    new Buffer(
      "<body>\n" +
        "<script>\n" +
        "  if (window.parent) {\n" +
        "   if (/thirdparty=yes/.test(document.cookie)) {\n" +
        "     window.parent.postMessage('MM:3PCsupported', '*');\n" +
        "   } else {\n" +
        "     window.parent.postMessage('MM:3PCunsupported', '*');\n" +
        "   }\n" +
        "   document.cookie = 'thirdparty=; expires=Thu, 01 Jan 1970 00:00:01 GMT;';\n" +
        "  }\n" +
        "</script>\n" +
        "</body>"
    )
  );
}

function makeFileFetcher(
  hostname?: string,
  port?: string | number,
  path?: string,
  headers?: { "Content-Type": string },
  preloadData?: { conversation?: ConversationType }
) {
  return function (
    req: { headers?: { host: any }; path: any; pipe: (arg0: any) => void },
    res: { set: (arg0: any) => void }
  ) {
    const hostname = buildStaticHostname(req, res);
    if (!hostname) {
      fail(res, 500, "polis_err_file_fetcher_serving_to_domain");
      console.error(req?.headers?.host);
      console.error(req.path);
      return;
    }
    // pol.is.s3-website-us-east-1.amazonaws.com
    // preprod.pol.is.s3-website-us-east-1.amazonaws.com

    // TODO https - buckets would need to be renamed to have dashes instead of dots.
    // http://stackoverflow.com/questions/3048236/amazon-s3-https-ssl-is-it-possible
    const url = "http://" + hostname + ":" + port + path;
    winston.log("info", "fetch file from " + url);
    let x = request(url);
    req.pipe(x);
    if (!_.isUndefined(preloadData)) {
      x = x.pipe(
        replaceStream(
          '"REPLACE_THIS_WITH_PRELOAD_DATA"',
          JSON.stringify(preloadData)
        )
      );
    }

    let fbMetaTagsString =
      '<meta property="og:image" content="https://s3.amazonaws.com/pol.is/polis_logo.png" />\n';
    if (preloadData && preloadData.conversation) {
      fbMetaTagsString +=
        '    <meta property="og:title" content="' +
        preloadData.conversation.topic +
        '" />\n';
      fbMetaTagsString +=
        '    <meta property="og:description" content="' +
        preloadData.conversation.description +
        '" />\n';
    }
    x = x.pipe(
      replaceStream(
        "<!-- REPLACE_THIS_WITH_FB_META_TAGS -->",
        fbMetaTagsString
      )
    );

    res.set(headers);

    x.pipe(res);
    x.on("error", function (err: any) {
      fail(res, 500, "polis_err_finding_file " + path, err);
    });
  };
}

function isUnsupportedBrowser(req: { headers?: { [x: string]: string } }) {
  return /MSIE [234567]/.test(req?.headers?.["user-agent"] || "");
}

function browserSupportsPushState(req: {
  headers?: { [x: string]: string };
}) {
  return !/MSIE [23456789]/.test(req?.headers?.["user-agent"] || "");
}

// serve up index.html in response to anything starting with a number
const hostname: string = Config.staticFilesHost;
const staticFilesClientPort: number = Config.staticFilesClientPort;
const staticFilesAdminPort: number = Config.staticFilesAdminPort;
const fetchUnsupportedBrowserPage = makeFileFetcher(
  hostname,
  staticFilesClientPort,
  "/unsupportedBrowser.html",
  {
    "Content-Type": "text/html",
  }
);

function fetchIndex(
  req: { path: string; headers?: { host: string } },
  res: {
    writeHead: (arg0: number, arg1: { Location: string }) => void;
    end: () => any;
  },
  preloadData: { conversation?: ConversationType },
  port: string | number | undefined,
  buildNumber?: string | null | undefined
) {
  const headers = {
    "Content-Type": "text/html",
  };
  if (!devMode) {
    Object.assign(headers, {
      "Cache-Control": "no-cache", // Cloudflare will probably cache it for one or two hours
    });
  }

  setCookieTestCookie(req, res, shouldSetCookieOnPolisDomain(req));

  if (devMode) {
    buildNumber = null;
  }

  const indexPath =
    (buildNumber ? "/cached/" + buildNumber : "") + "/index.html";

  const doFetch = makeFileFetcher(
    hostname,
    port,
    indexPath,
    headers,
    preloadData
  );
  if (isUnsupportedBrowser(req)) {
    return fetchUnsupportedBrowserPage(req, res);
  } else if (
    !browserSupportsPushState(req) &&
    req.path.length > 1 &&
    // TODO probably better to create a list of client-side route regexes (whitelist), rather than trying to blacklist
    // things like API calls.
    !/^\/api/.exec(req.path)
  ) {
    // Redirect to the same URL with the path behind the fragment "#"
    res.writeHead(302, {
      Location: "https://" + req?.headers?.host + "/#" + req.path,
    });

    return res.end();
  } else {
    return doFetch(req, res);
  }
}

function fetchIndexWithoutPreloadData(req: any, res: any, port: any) {
  return fetchIndex(req, res, {}, port);
}

function ifDefinedFirstElseSecond(first: any, second: boolean) {
  return _.isUndefined(first) ? second : first;
}

const fetch404Page = makeFileFetcher(
  hostname,
  staticFilesAdminPort,
  "/404.html",
  {
    "Content-Type": "text/html",
  }
);

function fetchIndexForConversation(
  req: { path: string; query?: { build: any } },
  res: any
) {
  console.log("fetchIndexForConversation", req.path);
  const match = req.path.match(/[0-9][0-9A-Za-z]+/);
  let conversation_id: any;
  if (match && match.length) {
    conversation_id = match[0];
  }
  let buildNumber = null;
  if (req?.query?.build) {
    buildNumber = req.query.build;
    console.log("loading_build", buildNumber);
  }

  setTimeout(function () {
    // Kick off requests to twitter and FB to get the share counts.
    // This will be nice because we cache them so it will be fast when
    // client requests these later.
    // TODO actually store these values in a cache that is shared between
    // the servers, probably just in the db.
    getTwitterShareCountForConversation(conversation_id).catch(function (
      err: string
    ) {
      console.log(
        "fetchIndexForConversation/getTwitterShareCountForConversation err " +
          err
      );
    });
    getFacebookShareCountForConversation(conversation_id).catch(function (
      err: string
    ) {
      console.log(
        "fetchIndexForConversation/getFacebookShareCountForConversation err " +
          err
      );
    });
  }, 100);

  doGetConversationPreloadInfo(conversation_id)
    .then(function (x: any) {
      const preloadData = {
        conversation: x,
        // Nothing user-specific can go here, since we want to cache these per-conv index files on the CDN.
      };
      fetchIndex(req, res, preloadData, staticFilesClientPort, buildNumber);
    })
    .catch(function (err: any) {
      fetch404Page(req, res);
      // fail(res, 500, "polis_err_fetching_conversation_info2", err);
    });
}

const fetchIndexForAdminPage = makeFileFetcher(
  hostname,
  staticFilesAdminPort,
  "/index_admin.html",
  {
    "Content-Type": "text/html",
  }
);

const fetchIndexForReportPage = makeFileFetcher(
  hostname,
  staticFilesAdminPort,
  "/index_report.html",
  {
    "Content-Type": "text/html",
  }
);

function handle_GET_iip_conversation(
  req: { params: { conversation_id: any } },
  res: {
    set: (arg0: { "Content-Type": string }) => void;
    send: (arg0: string) => void;
  }
) {
  const conversation_id = req.params.conversation_id;
  res.set({
    "Content-Type": "text/html",
  });
  res.send(
    "<a href='https://pol.is/" +
      conversation_id +
      "' target='_blank'>" +
      conversation_id +
      "</a>"
  );
}

function handle_GET_iim_conversation(
  req: { p: { zid: any }; params: { conversation_id: any } },
  res: {
    set: (arg0: { "Content-Type": string }) => void;
    send: (arg0: string) => void;
  }
) {
  const zid = req.p.zid;
  const conversation_id = req.params.conversation_id;
  getConversationInfo(zid)
    .then(function (info: { topic: any; created: any; description: string }) {
      res.set({
        "Content-Type": "text/html",
      });
      const title = info.topic || info.created;
      res.send(
        "<a href='https://pol.is/" +
          conversation_id +
          "' target='_blank'>" +
          title +
          "</a>" +
          "<p><a href='https://pol.is/m" +
          conversation_id +
          "' target='_blank'>moderate</a></p>" +
          (info.description ? "<p>" + info.description + "</p>" : "")
      );
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_fetching_conversation_info", err);
    });
}

function handle_GET_twitter_image(
  req: { p: { id: any } },
  res: {
    setHeader: (arg0: string, arg1: string) => void;
    writeHead: (arg0: number) => void;
    end: (arg0: string) => void;
    status: (
      arg0: number
    ) => { (): any; new (): any; end: { (): void; new (): any } };
  }
) {
  console.log("handle_GET_twitter_image", req.p.id);
  getTwitterUserInfo(
    {
      twitter_user_id: req.p.id,
    },
    true
  )
    .then(function (data: string) {
      const parsedData = JSON.parse(data);
      if (!parsedData || !parsedData.length) {
        fail(res, 500, "polis_err_finding_twitter_user_info");
        return;
      }
      const url = parsedData[0].profile_image_url; // not https to save a round-trip
      let finished = false;
      http
        .get(url, function (twitterResponse: { pipe: (arg0: any) => void }) {
          if (!finished) {
            clearTimeout(timeoutHandle);
            finished = true;
            res.setHeader(
              "Cache-Control",
              "no-transform,public,max-age=18000,s-maxage=18000"
            );
            twitterResponse.pipe(res);
          }
        })
        .on("error", function (err: any) {
          finished = true;
          fail(res, 500, "polis_err_finding_file " + url, err);
        });

      const timeoutHandle = setTimeout(function () {
        if (!finished) {
          finished = true;
          res.writeHead(504);
          res.end("request timed out");
          console.log("twitter_image timeout");
        }
      }, 9999);
    })
    .catch(function (err: { stack: any }) {
      console.error("polis_err_missing_twitter_image", err);
      if (err && err.stack) {
        console.error(err.stack);
      }
      res.status(500).end();
    });
}

const handle_GET_conditionalIndexFetcher = (function () {
  return function (req: any, res: { redirect: (arg0: string) => void }) {
    if (hasAuthToken(req)) {
      // user is signed in, serve the app
      return fetchIndexForAdminPage(req, res);
    } else if (!browserSupportsPushState(req)) {
      // TEMPORARY: Don't show the landing page.
      // The problem is that /user/create redirects to #/user/create,
      // which ends up here, and since there's no auth token yet,
      // we would show the lander. One fix would be to serve up the auth page
      // as a separate html file, and not rely on JS for the routing.
      return fetchIndexForAdminPage(req, res);
    } else {
      // user not signed in, redirect to landing page
      const url = getServerNameWithProtocol(req) + "/home";
      res.redirect(url);
    }
  };
})();

function handle_GET_localFile_dev_only(
  req: { path: any },
  res: {
    writeHead: (
      arg0: number,
      arg1?: { "Content-Type": string } | undefined
    ) => void;
    end: (arg0?: undefined, arg1?: string) => void;
  }
) {
  const filenameParts = String(req.path).split("/");
  filenameParts.shift();
  filenameParts.shift();
  const filename = filenameParts.join("/");
  if (!devMode) {
    // pretend this route doesn't exist.
    return proxy(req, res);
  }
  fs.readFile(filename, function (error: any, content: any) {
    if (error) {
      res.writeHead(500);
      res.end();
    } else {
      res.writeHead(200, {
        "Content-Type": "text/html",
      });
      res.end(content, "utf-8");
    }
  });
}

function middleware_log_request_body(
  req: { body: any; path: string },
  res: any,
  next: () => void
) {
  if (devMode) {
    let b = "";
    if (req.body) {
      const temp = _.clone(req.body);
      if (temp.password) {
        temp.password = "some_password";
      }
      if (temp.newPassword) {
        temp.newPassword = "some_password";
      }
      if (temp.password2) {
        temp.password2 = "some_password";
      }
      if (temp.hname) {
        temp.hname = "somebody";
      }
      if (temp.polisApiKey) {
        temp.polisApiKey = "pkey_somePolisApiKey";
      }
      b = JSON.stringify(temp);
    }
    winston.log("info", req.path + " " + b);
  } else {
    // don't log the route or params, since Heroku does that for us.
  }
  next();
}

function middleware_log_middleware_errors(
  err: { stack: any },
  req: any,
  res: any,
  next: (arg0?: { stack: any }) => void
) {
  if (!err) {
    return next();
  }
  winston.log("info", "error found in middleware");
  console.error(err);
  if (err && err.stack) {
    console.error(err.stack);
  }
  yell(err);
  next(err);
}

function middleware_check_if_options(
  req: { method: string },
  res: { send: (arg0: number) => any },
  next: () => any
) {
  if (req.method.toLowerCase() !== "options") {
    return next();
  }
  return res.send(204);
}

const middleware_responseTime_start = responseTime(function (
  req: { route: { path: any } },
  res: any,
  time: number
) {
  if (req && req.route && req.route.path) {
    const path = req.route.path;
    time = Math.trunc(time);
    addInRamMetric(path, time);
  }
});
