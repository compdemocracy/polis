import _ from "underscore";
import { addExtendedParticipantInfo, joinConversation } from "../participant";
import { failJson } from "../utils/fail";
import { getConversationInfo, getXidRecord } from "../conversation";
import { getPca } from "../utils/pca";
import { getPid, getUser, getPidPromise } from "../user";
import { getVotesForSingleParticipant } from "./votes";
import { getXids } from "./math";
import { isConversationOwner, isOwner } from "../utils/common";
import { issueAnonymousJWT, issueStandardUserJWT, issueXidJWT } from "../auth";
import { MPromise } from "../utils/metered";
import { sql_participants_extended } from "../db/sql";
import { userHasAnsweredZeQuestions } from "../server-helpers";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import {
  ParticipantFields,
  ParticipantInfo,
  ExpressResponse,
  Headers,
} from "../d";
import {
  doFamousQuery,
  updateLastInteractionTimeForConversation,
  getNextComment,
  getOneConversation,
} from "../server-helpers";
import { checkLegacyCookieAndIssueJWT } from "../auth/legacyCookies";

// basic defaultdict implementation
function DD(this: any, f: () => { votes: number; comments: number }) {
  this.m = {};
  this.f = f;
}
// basic defaultarray implementation
function DA(this: any, f: any) {
  this.m = [];
  this.f = f;
}
DD.prototype.g = DA.prototype.g = function (k: string | number) {
  if (this.m.hasOwnProperty(k)) {
    return this.m[k];
  }
  const v = this.f(k);
  this.m[k] = v;
  return v;
};
DD.prototype.s = DA.prototype.s = function (k: string | number, v: any) {
  this.m[k] = v;
};

function _isOwnerOrParticipant(
  zid: number,
  uid?: number,
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

// returns null if it's missing
function _getParticipant(zid: number, uid?: number) {
  return MPromise(
    "_getParticipant",
    function (resolve: (arg0: any) => void, reject: (arg0: Error) => any) {
      pg.query_readOnly(
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

function handle_GET_participants(
  req: { p: { uid?: number; zid: number } },
  res: ExpressResponse
) {
  // let pid = req.p.pid;
  const uid = req.p.uid;
  const zid = req.p.zid;

  pg.queryP_readOnly(
    "select * from participants where uid = ($1) and zid = ($2)",
    [uid, zid]
  )
    .then(function (rows: string | any[]) {
      const ptpt = (rows && rows.length && rows[0]) || null;
      res.status(200).json(ptpt);
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_get_participant", err);
    });
}

function handle_POST_participants(
  req: {
    p: {
      zid: number;
      uid?: number;
      answers: any;
      parent_url: any;
      referrer: any;
    };
  },
  res: ExpressResponse
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const answers = req.p.answers;
  const info: ParticipantInfo = {};

  // Use direct parameters - no cookie fallback
  const parent_url = req.p.parent_url;
  const referrer = req.p.referrer;

  if (parent_url) {
    info.parent_url = parent_url;
  }
  if (referrer) {
    info.referrer = referrer;
  }

  function finish(ptpt: any) {
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
            failJson(res, 500, "polis_err_add_participant", err);
          }
        );
      },
      function (err: { message: any }) {
        failJson(res, 400, err.message, err);
      }
    );
  }

  // Check if already in the conversation
  _getParticipant(zid, req.p.uid)
    .then(
      function (ptpt: { pid: number }) {
        if (ptpt) {
          finish(ptpt);
          addExtendedParticipantInfo(zid, req.p.uid, info);
          return;
        }

        getConversationInfo(zid)
          .then(function () {
            doJoin();
          })
          .catch(function (err: any) {
            failJson(
              res,
              500,
              "polis_err_post_participants_need_uid_to_check_lti_users_4",
              err
            );
          });
      },
      function (err: any) {
        failJson(res, 500, "polis_err_post_participants_db_err", err);
      }
    )
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_post_participants_misc", err);
    });
}

function handle_GET_participation(
  req: { p: { zid: number; uid?: number; strict: any } },
  res: ExpressResponse
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const strict = req.p.strict;
  isOwner(zid, uid)
    .then(function (ok: any) {
      if (!ok) {
        failJson(res, 403, "polis_err_get_participation_auth");
        return;
      }

      return Promise.all([
        pg.queryP_readOnly(
          "select pid, count(*) from votes where zid = ($1) group by pid;",
          [zid]
        ),
        pg.queryP_readOnly(
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
          failJson(
            res,
            409,
            "polis_err_get_participation_missing_xids This conversation has no xids for its participants."
          );
          return;
        }

        // Build a map like this {xid -> {votes: 10, comments: 2}}
        //           (property) votes: number
        let result = new DD(function () {
          return { votes: 0, comments: 0 };
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
            failJson(
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
      failJson(res, 500, "polis_err_get_participation_misc", err);
    });
}

async function handle_GET_participationInit(
  req: {
    p: {
      anonymous_participant?: boolean;
      oidc_sub?: string;
      oidcUser?: any;
      conversation_id: string;
      jwt_conversation_id?: string;
      jwt_conversation_mismatch?: boolean;
      jwt_xid?: string;
      lang: string;
      owner_uid?: number;
      pid: number;
      requested_conversation_id?: string;
      standard_user_participant?: boolean;
      uid?: number;
      xid_participant?: boolean;
      xid: string;
      zid: number;
    };
    headers?: Headers;
  },
  res: ExpressResponse
) {
  try {
    logger.debug(`handle_GET_participationInit ${JSON.stringify(req.p)}`);
    // Handle language preference
    const acceptLanguage =
      req?.headers?.["accept-language"] ||
      req?.headers?.["Accept-Language"] ||
      "en-US";

    if (req.p.lang === "acceptLang") {
      req.p.lang = acceptLanguage.substr(0, 2);
    }

    // Build response object
    const response: any = {
      user: {},
      ptpt: null,
      nextComment: null,
      conversation: null,
      votes: [],
      pca: null,
      famous: null,
      acceptLanguage: acceptLanguage,
    };

    // If no conversation ID, return minimal response
    if (!req.p.conversation_id) {
      const user = await getUser(
        req.p.uid,
        req.p.zid,
        req.p.xid,
        req.p.owner_uid
      );
      response.user = user;
      return res.status(200).json(response);
    }

    // Handle JWT conversation mismatches for anonymous participants
    if (req.p.jwt_conversation_mismatch && req.p.anonymous_participant) {
      logger.debug(
        "Anonymous participant with JWT for different conversation - treating as new participant"
      );
      // Clear the uid/pid from the mismatched JWT
      req.p.uid = undefined;
      req.p.pid = -1;
    }

    // Handle JWT conversation mismatches for XID participants
    if (req.p.jwt_conversation_mismatch && req.p.xid_participant && req.p.xid) {
      // Determine which case we're in
      const jwtXid = req.p.jwt_xid;
      const requestXid = req.p.xid;

      // Check if XID in request matches XID in JWT
      const xidMatches = jwtXid === requestXid;

      // Get XID record for the requested conversation
      let xidForRequestedConversation = false;
      try {
        const xidRecords = await getXidRecord(requestXid, req.p.zid);
        if (xidRecords && xidRecords.length > 0) {
          xidForRequestedConversation = true;
        }
      } catch (err) {
        // XID not found for this conversation
      }

      if (xidMatches) {
        // Case 2: Token and XID align but are for a different conversation
        logger.debug(
          "Case 2: XID JWT and request XID match but for different conversation - treating as anonymous"
        );
        req.p.xid = ""; // Clear XID to treat as anonymous
        req.p.uid = undefined;
        req.p.pid = -1;
      } else if (!xidMatches && xidForRequestedConversation) {
        // Case 3: Token is for different conversation, but XID is for current conversation
        logger.debug(
          "Case 3: JWT for different conversation but XID is for current conversation - maintaining XID"
        );
        // Clear JWT-based uid/pid, will be resolved from XID below
        req.p.uid = undefined;
        req.p.pid = -1;
      } else {
        // Case 4: Token is for current conversation, but XID is for another conversation
        logger.debug(
          "Case 4: JWT for current conversation but XID for different conversation - treating as anonymous"
        );
        req.p.xid = ""; // Clear XID to treat as anonymous
        // Keep the uid/pid from the JWT since it's for the current conversation
      }
    }

    // Check for legacy cookie before proceeding
    let legacyCookieToken: string | undefined;
    if (
      req.p.uid === undefined &&
      !req.p.jwt_conversation_mismatch &&
      req.p.conversation_id
    ) {
      const legacyResult = await checkLegacyCookieAndIssueJWT(
        req,
        req.p.zid,
        req.p.conversation_id,
        req.p.xid
      );
      if (legacyResult.uid !== undefined && legacyResult.pid !== undefined) {
        req.p.uid = legacyResult.uid;
        req.p.pid = legacyResult.pid;
        legacyCookieToken = legacyResult.token;
        logger.info(
          "Using existing participant from legacy cookie in participationInit",
          {
            uid: legacyResult.uid,
            pid: legacyResult.pid,
          }
        );
      }
    }

    // For XID users, resolve XID to UID first
    let effectiveUidForUser = req.p.uid;
    if (req.p.xid && !req.p.uid) {
      try {
        const xidRecords = await getXidRecord(req.p.xid, req.p.zid);
        if (xidRecords && xidRecords.length > 0) {
          effectiveUidForUser = xidRecords[0].uid;
        }
      } catch (err) {
        logger.warn("Error looking up XID record for user resolution:", err);
      }
    }

    // Fetch user and conversation data in parallel
    const [user, ptpt, conv, pcaData] = await Promise.all([
      getUser(effectiveUidForUser, req.p.zid, req.p.xid, req.p.owner_uid),
      effectiveUidForUser
        ? _getParticipant(req.p.zid, effectiveUidForUser)
        : Promise.resolve(null),
      getOneConversation(req.p.zid, effectiveUidForUser, null),
      getPca(req.p.zid, undefined),
    ]);

    response.user = user;
    response.ptpt = ptpt;
    response.conversation = conv;
    response.pca = pcaData?.asPOJO ? pcaData : null;

    // Determine the correct pid for this user
    let effectivePid = req.p.pid;
    let effectiveUid: number | undefined;

    if (req.p.xid && typeof user === "object" && "xInfo" in user) {
      // Handle XID users
      const userWithXInfo = user as any;
      if (userWithXInfo.xInfo?.uid !== undefined) {
        effectiveUid = userWithXInfo.xInfo.uid;
        try {
          const actualPid = await getPidPromise(req.p.zid, effectiveUid);
          if (actualPid >= 0) {
            effectivePid = actualPid;
          }
        } catch (err) {
          logger.warn("Error getting pid for XID user", err);
        }
      } else if (userWithXInfo.uid !== undefined && userWithXInfo.pid >= 0) {
        effectiveUid = userWithXInfo.uid;
        effectivePid = userWithXInfo.pid;
      }
    } else if (req.p.uid && typeof user === "object" && "pid" in user) {
      const userWithPid = user as any;
      if (userWithPid.pid >= 0) {
        effectivePid = userWithPid.pid;
      }
    }

    // Fetch data that depends on the effective pid
    const [votes, nextComment, famous] = await Promise.all([
      getVotesForSingleParticipant({
        pid: effectivePid,
        zid: req.p.zid,
      }),
      getNextComment(req.p.zid, effectivePid, [], true, req.p.lang),
      doFamousQuery({
        uid: req.p.uid,
        zid: req.p.zid,
        math_tick: response.pca?.math_tick || 0,
        ptptoiLimit: 30,
      }),
    ]);

    response.votes = votes || [];
    response.nextComment = nextComment;
    response.famous = famous || {};

    // Issue JWT based on user type
    if (legacyCookieToken) {
      // Use the JWT from legacy cookie lookup
      response.auth = {
        token: legacyCookieToken,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60, // 1 year
      };
      logger.debug("Using JWT from legacy cookie lookup in participationInit");
    } else if (
      req.p.oidc_sub &&
      effectiveUid !== undefined &&
      effectivePid >= 0
    ) {
      // Issue JWT for standard users (OIDC authenticated)
      try {
        const token = issueStandardUserJWT(
          req.p.oidc_sub,
          req.p.conversation_id,
          effectiveUid,
          effectivePid
        );

        response.auth = {
          token: token,
          token_type: "Bearer",
          expires_in: 365 * 24 * 60 * 60, // 1 year
        };

        logger.debug("Standard user JWT issued successfully", {
          oidc_sub: req.p.oidc_sub,
          uid: effectiveUid,
          pid: effectivePid,
        });
      } catch (error) {
        logger.error("Failed to issue standard user JWT:", error);
      }
    } else if (req.p.xid && effectiveUid !== undefined && effectivePid >= 0) {
      // Issue JWT for XID users
      try {
        const token = issueXidJWT(
          req.p.xid,
          req.p.conversation_id,
          effectiveUid,
          effectivePid
        );

        response.auth = {
          token: token,
          token_type: "Bearer",
          expires_in: 365 * 24 * 60 * 60, // 1 year
        };

        logger.debug("XID JWT issued successfully", {
          xid: req.p.xid,
          uid: effectiveUid,
          pid: effectivePid,
        });
      } catch (error) {
        logger.error("Failed to issue XID JWT:", error);
      }
    } else if (!req.p.xid && effectiveUid !== undefined && effectivePid >= 0) {
      // Issue JWT for anonymous users if they already exist
      try {
        const token = issueAnonymousJWT(
          req.p.conversation_id,
          effectiveUid,
          effectivePid
        );

        response.auth = {
          token: token,
          token_type: "Bearer",
          expires_in: 365 * 24 * 60 * 60, // 1 year
        };

        logger.debug("Anonymous JWT issued successfully", {
          uid: effectiveUid,
          pid: effectivePid,
        });
      } catch (error) {
        logger.error("Failed to issue anonymous JWT:", error);
      }
    }
    // Note: New anonymous participants get JWTs on first action (like voting), not on participationInit

    // Clean up sensitive data
    if (response.conversation) {
      delete response.conversation.zid;
      response.conversation.conversation_id = req.p.conversation_id;
    }

    if (response.ptpt) {
      delete response.ptpt.zid;
    }

    response.votes.forEach((vote: any) => {
      delete vote.zid;
    });

    if (response.nextComment && effectivePid !== undefined) {
      response.nextComment.currentPid = effectivePid;
    }

    res.status(200).json(response);
  } catch (err) {
    logger.error("Error in handle_GET_participationInit:", err);
    failJson(res, 500, "polis_err_get_participationInit", err);
  }
}

function handle_PUT_participants_extended(
  req: { p: { zid: number; uid?: number; show_translation_activated: any } },
  res: ExpressResponse
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

  pg.queryP(q.toString(), [])
    .then((result: any) => {
      res.json(result);
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_put_participants_extended", err);
    });
}

function handle_POST_query_participants_by_metadata(
  req: { p: { uid?: number; zid: number; pmaids: any } },
  res: ExpressResponse
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
    pg.query_readOnly(
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
          failJson(res, 500, "polis_err_metadata_query", err);
          return;
        }
        res.status(200).json(_.pluck(results.rows, "pid") as any[]);
      }
    );
  }

  _isOwnerOrParticipant(zid, uid, doneChecking);
}

export {
  handle_GET_participants,
  handle_GET_participation,
  handle_GET_participationInit,
  handle_POST_participants,
  handle_POST_query_participants_by_metadata,
  handle_PUT_participants_extended,
};
