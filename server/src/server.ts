/* eslint-disable no-console */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import akismetLib from "akismet";
import AWS from "aws-sdk";
import { Promise as BluebirdPromise } from "bluebird";
import _ from "underscore";
import { METRICS_IN_RAM } from "./utils/metered";
import { generateAndRegisterZinvite, generateTokenP } from "./auth";
import pg from "./db/pg-query";
import Config from "./config";
import { failJson } from "./utils/fail";
import { fetchAndCacheLatestPcaData } from "./utils/pca";
import { getPidsForGid } from "./utils/participants";
import { fetchIndex, makeFileFetcher } from "./utils/file-fetcher";
import {
  addNoMoreCommentsRecord,
  addStar,
  browserSupportsPushState,
  finishOne,
  getNextComment,
  pullXInfoIntoSubObjects,
  safeTimestampToMillis,
  updateConversationModifiedTime,
  updateLastInteractionTimeForConversation,
} from "./server-helpers";
import {
  DetectLanguageResult,
  ParticipantCommentModerationResult,
  UserType,
  ExpressRequest,
  ExpressResponse,
} from "./d";
import { getConversationInfo } from "./conversation";
import Comment from "./comment";
import logger from "./utils/logger";
import {
  emailTeam,
  sendMultipleTextEmails,
  sendTextEmail,
  sendTextEmailWithBackup,
} from "./email/senders";
import { isDuplicateKey, isModerator, isPolisDev } from "./utils/common";

AWS.config.update({ region: Config.awsRegion });
const devMode = Config.isDevMode;

if (devMode) {
  BluebirdPromise.longStackTraces();
}

// Bluebird uncaught error handler.
BluebirdPromise.onPossiblyUnhandledRejection(function (err: any) {
  logger.error("onPossiblyUnhandledRejection", err);
  // throw err; // not throwing since we're printing stack traces anyway
});

const adminEmails = Config.adminEmails ? JSON.parse(Config.adminEmails) : [];

const polisFromAddress = Config.polisFromAddress;

const serverUrl = Config.getServerUrl(); // typically https://pol.is or http://localhost:5000

const akismet = akismetLib.client({
  blog: serverUrl,
  apiKey: Config.akismetAntispamApiKey,
});

akismet.verifyKey(function (err: any, verified: any) {
  if (verified) {
    logger.debug("Akismet: API key successfully verified.");
  }
});

function haltOnTimeout(req: { timedout: any }, res: any, next: () => void) {
  if (req.timedout) {
    failJson(res, 500, "polis_err_timeout_misc");
  } else {
    next();
  }
}

function initializePolisHelpers() {
  const detectLanguage = Comment.detectLanguage;

  if (Config.backfillCommentLangDetection) {
    pg.queryP(
      "select tid, txt, zid from comments where lang is null;",
      []
    ).then((comments: string | any[]) => {
      let i = 0;
      function doNext() {
        if (i < comments.length) {
          const c = comments[i];
          i += 1;
          detectLanguage(c.txt).then((x: DetectLanguageResult[]) => {
            const firstResult = x[0];
            logger.debug("backfill " + firstResult.language + "\t\t" + c.txt);
            pg.queryP(
              "update comments set lang = ($1), lang_confidence = ($2) where zid = ($3) and tid = ($4)",
              [firstResult.language, firstResult.confidence, c.zid, c.tid]
            ).then(() => {
              doNext();
            });
          });
        }
      }
      doNext();
    });
  }

  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  //
  //             BEGIN ROUTES
  //
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////

  // don't start immediately, let other things load first.
  // setTimeout(fetchAndCacheLatestPcaData, 5000);
  fetchAndCacheLatestPcaData; // TODO_DELETE

  function redirectIfHasZidButNoConversationId(
    req: { body: { zid: number; conversation_id: string }; headers?: any },
    res: {
      writeHead: (arg0: number, arg1: { Location: string }) => void;
      end: () => any;
    },
    next: () => any
  ) {
    if (req.body.zid && !req.body.conversation_id) {
      logger.info("redirecting old zid user to about page");

      const path = "/about";
      const protocol = req.headers["x-forwarded-proto"] || "http";

      res.writeHead(302, {
        Location: protocol + "://" + req?.headers?.host + path,
      });
      return res.end();
    }
    return next();
  }

  function doAddDataExportTask(
    math_env: string | undefined,
    email: string,
    zid: number,
    atDate: number,
    format: string,
    task_bucket: number
  ) {
    return pg.queryP(
      "insert into worker_tasks (math_env, task_data, task_type, task_bucket) values ($1, $2, 'generate_export_data', $3);",
      [
        math_env,
        {
          email: email,
          zid: zid,
          "at-date": atDate,
          format: format,
        },
        task_bucket, // TODO hash the params to get a consistent number?
      ]
    );
  }
  if (
    Config.runPeriodicExportTests &&
    !devMode &&
    Config.mathEnv === "preprod"
  ) {
    const runExportTest = () => {
      const math_env = "prod";
      const email = Config.adminEmailDataExportTest;
      const zid = 12480;
      const atDate = Date.now();
      const format = "csv";
      const task_bucket = Math.abs((Math.random() * 999999999999) >> 0);
      doAddDataExportTask(
        math_env,
        email,
        zid,
        atDate,
        format,
        task_bucket
      ).then(() => {
        setTimeout(() => {
          pg.queryP(
            "select * from worker_tasks where task_type = 'generate_export_data' and task_bucket = ($1);",
            [task_bucket]
          ).then((rows: string | any[]) => {
            const ok = rows && rows.length;
            let newOk;
            if (ok) {
              newOk = rows[0].finished_time > 0;
            }
            if (ok && newOk) {
              logger.info("runExportTest success");
            } else {
              logger.error("runExportTest failed");
              emailBadProblemTime("Math export didn't finish.");
            }
          });
        }, 10 * 60 * 1000); // wait 10 minutes before verifying
      });
    };
    setInterval(runExportTest, 6 * 60 * 60 * 1000); // every 6 hours
  }

  const getServerNameWithProtocol = Config.getServerNameWithProtocol;

  function handle_POST_metrics(
    req: {
      p: {
        uid: null;
        durs: any[];
        clientTimestamp: any;
        times: any[];
        types: any[];
      };
    },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): any; new (): any };
      };
      json: (arg0: {}) => void;
    }
  ) {
    const enabled = false;
    if (!enabled) {
      return res.status(200).json({});
    }

    const uid = req.p.uid || null;
    const durs = req.p.durs.map(function (dur: number | null) {
      if (dur === -1) {
        dur = null;
      }
      return dur;
    });
    const clientTimestamp = req.p.clientTimestamp;
    const ages = req.p.times.map(function (t: number) {
      return clientTimestamp - t;
    });
    const now = Date.now();
    const timesInTermsOfServerTime = ages.map(function (a: number) {
      return now - a;
    });
    const len = timesInTermsOfServerTime.length;
    const entries = [];
    for (let i = 0; i < len; i++) {
      entries.push(
        "(" +
          [
            uid || "null",
            req.p.types[i],
            durs[i],
            undefined,
            timesInTermsOfServerTime[i],
          ].join(",") +
          ")"
      );
    }

    pg.queryP(
      "insert into metrics (uid, type, dur, hashedPc, created) values " +
        entries.join(",") +
        ";",
      []
    )
      .then(function () {
        res.json({});
      })
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_metrics_post", err);
      });
  }

  function handle_GET_zinvites(
    req: { p: { zid: number; uid?: number } },
    res: {
      writeHead: (arg0: number) => void;
      json: (arg0: { status: number }) => void;
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: { codes: any }): void; new (): any };
      };
    }
  ) {
    // if uid is not conversation owner, fail
    pg.query_readOnly(
      "SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);",
      [req.p.zid, req.p.uid],
      function (err: any, results: { rows: any }) {
        if (err) {
          failJson(
            res,
            500,
            "polis_err_fetching_zinvite_invalid_conversation_or_owner",
            err
          );
          return;
        }
        if (!results || !results.rows) {
          res.writeHead(404);
          res.json({
            status: 404,
          });
          return;
        }
        pg.query_readOnly(
          "SELECT * FROM zinvites WHERE zid = ($1);",
          [req.p.zid],
          function (err: any, results: { rows: any }) {
            if (err) {
              failJson(
                res,
                500,
                "polis_err_fetching_zinvite_invalid_conversation_or_owner_or_something",
                err
              );
              return;
            }
            if (!results || !results.rows) {
              res.writeHead(404);
              res.json({
                status: 404,
              });
              return;
            }
            res.status(200).json({
              codes: results.rows, // _.pluck(results.rows[0],"code");
            });
          }
        );
      }
    );
  }

  function handle_POST_zinvites(
    req: { p: { short_url: any; zid: number; uid?: number } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: { zinvite: string }): void; new (): any };
      };
    }
  ) {
    const generateShortUrl = req.p.short_url;

    pg.query(
      "SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);",
      [req.p.zid, req.p.uid],
      function (err: any) {
        if (err) {
          failJson(
            res,
            500,
            "polis_err_creating_zinvite_invalid_conversation_or_owner",
            err
          );
          return;
        }

        generateAndRegisterZinvite(req.p.zid, generateShortUrl)
          .then(function (zinvite: any) {
            res.status(200).json({
              zinvite: zinvite,
            });
          })
          .catch(function (err: any) {
            failJson(res, 500, "polis_err_creating_zinvite", err);
          });
      }
    );
  }

  function emailFeatureRequest(message: string) {
    const body = `Somebody clicked a dummy button!

${message}`;

    return sendMultipleTextEmails(
      polisFromAddress,
      adminEmails,
      "Dummy button clicked!!!",
      body
    ).catch(function (err: any) {
      logger.error("polis_err_failed_to_email_for_dummy_button", {
        message,
        err,
      });
    });
  }

  function emailBadProblemTime(message: string) {
    const body = `Yo, there was a serious problem. Here's the message:

${message}`;

    return emailTeam("Polis Bad Problems!!!", body);
  }

  function trySendingBackupEmailTest() {
    if (devMode) {
      return;
    }
    const d = new Date();
    if (d.getDay() === 1) {
      // send the monday backup email system test
      // If the sending fails, we should get an error ping.
      sendTextEmailWithBackup(
        polisFromAddress,
        Config.adminEmailEmailTest,
        "monday backup email system test",
        "seems to be working"
      );
    }
  }
  setInterval(trySendingBackupEmailTest, 1000 * 60 * 60 * 23); // try every 23 hours (so it should only try roughly once a day)
  trySendingBackupEmailTest();
  function sendEinviteEmail(req: any, email: any, einvite: any) {
    const serverName = getServerNameWithProtocol(req);
    const body = `Welcome to pol.is!

Click this link to open your account:

${serverName}/welcome/${einvite}

Thank you for using Polis`;

    return sendTextEmail(
      polisFromAddress,
      email,
      "Get Started with Polis",
      body
    );
  }

  function handle_GET_verification(
    req: { p: { e: any } },
    res: {
      set: (arg0: string, arg1: string) => void;
      send: (arg0: string) => void;
    }
  ) {
    const einvite = req.p.e;
    pg.queryP("select * from einvites where einvite = ($1);", [einvite])
      .then(function (rows: string | any[]) {
        if (!rows.length) {
          failJson(res, 500, "polis_err_verification_missing");
        }
        const email = rows[0].email;
        return pg
          .queryP("select email from email_validations where email = ($1);", [
            email,
          ])
          .then(function (rows: string | any[]) {
            if (rows && rows.length > 0) {
              return true;
            }
            return pg.queryP(
              "insert into email_validations (email) values ($1);",
              [email]
            );
          });
      })
      .then(function () {
        res.set("Content-Type", "text/html");
        res.send(
          `<html><body>
<div style='font-family: Futura, Helvetica, sans-serif;'>
Email verified! You can close this tab or hit the back button.
</div>
</body></html>`
        );
      })
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_verification", err);
      });
  }

  function handle_GET_dummyButton(
    req: { p: { button: string; uid: string } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        end: { (): void; new (): any };
      };
    }
  ) {
    const message = req.p.button + " " + req.p.uid;
    emailFeatureRequest(message);
    res.status(200).end();
  }

  function handle_GET_perfStats(req: ExpressRequest, res: ExpressResponse) {
    res.json(METRICS_IN_RAM);
  }

  function handle_GET_snapshot() {
    if (true) {
      throw new Error(
        "TODO Needs to clone participants_extended and any other new tables as well."
      );
    }
  }

  function handle_POST_tutorial(
    req: { p: { uid?: any; step: any } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): void; new (): any };
      };
    }
  ) {
    const uid = req.p.uid;
    const step = req.p.step;
    pg.queryP("update users set tut = ($1) where uid = ($2);", [step, uid])
      .then(function () {
        res.status(200).json({});
      })
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_saving_tutorial_state", err);
      });
  }

  function handle_POST_ptptCommentMod(
    req: {
      p: {
        zid: number;
        pid: number;
        uid?: number;
        tid: number;
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
        lang: string;
      };
    },
    res: any
  ) {
    const zid = req.p.zid;
    const pid = req.p.pid;
    const uid = req.p.uid;

    return pg
      .queryP(
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
        return getNextComment(req.p.zid, pid, [], true, req.p.lang); // TODO req.p.lang is probably not defined
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
          failJson(res, 406, "polis_err_ptptCommentMod_duplicate", err); // TODO allow for changing votes?
        } else if (err === "polis_err_conversation_is_closed") {
          failJson(res, 403, "polis_err_conversation_is_closed", err);
        } else {
          failJson(res, 500, "polis_err_ptptCommentMod", err);
        }
      });
  }

  function handle_POST_upvotes(
    req: { p: { uid?: number; zid: number } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): void; new (): any };
      };
    }
  ) {
    const uid = req.p.uid;
    const zid = req.p.zid;

    pg.queryP("select * from upvotes where uid = ($1) and zid = ($2);", [
      uid,
      zid,
    ]).then(
      function (rows: string | any[]) {
        if (rows && rows.length) {
          failJson(res, 403, "polis_err_upvote_already_upvoted");
        } else {
          pg.queryP("insert into upvotes (uid, zid) VALUES ($1, $2);", [
            uid,
            zid,
          ]).then(
            function () {
              pg.queryP(
                "update conversations set upvotes = (select count(*) from upvotes where zid = ($1)) where zid = ($1);",
                [zid]
              ).then(
                function () {
                  res.status(200).json({});
                },
                function (err: any) {
                  failJson(res, 500, "polis_err_upvote_update", err);
                }
              );
            },
            function (err: any) {
              failJson(res, 500, "polis_err_upvote_insert", err);
            }
          );
        }
      },
      function (err: any) {
        failJson(res, 500, "polis_err_upvote_check", err);
      }
    );
  }

  function handle_POST_stars(
    req: { p: { zid: number; tid: number; pid: number; starred: any } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): void; new (): any };
      };
    }
  ) {
    addStar(req.p.zid, req.p.tid, req.p.pid, req.p.starred)
      .then(function (result: { rows: { created: any }[] }) {
        const createdTimeMillis = safeTimestampToMillis(result.rows[0].created);
        setTimeout(function () {
          updateConversationModifiedTime(req.p.zid, createdTimeMillis);
        }, 100);
        res.status(200).json({}); // TODO don't stop after the first one, map the inserts to deferreds.
      })
      .catch(function (err: any) {
        if (err) {
          if (isDuplicateKey(err)) {
            failJson(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
          } else {
            failJson(res, 500, "polis_err_vote", err);
          }
        }
      });
  }

  function handle_POST_trashes(
    req: { p: { pid: number; zid: number; tid: number; trashed: any } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): void; new (): any };
      };
    }
  ) {
    const query =
      "INSERT INTO trashes (pid, zid, tid, trashed, created) VALUES ($1, $2, $3, $4, default);";
    const params = [req.p.pid, req.p.zid, req.p.tid, req.p.trashed];
    pg.query(
      query,
      params,
      function (err: any, result: { rows: { created: any }[] }) {
        if (err) {
          if (isDuplicateKey(err)) {
            failJson(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
          } else {
            failJson(res, 500, "polis_err_vote", err);
          }
          return;
        }

        const createdTimeMillis = safeTimestampToMillis(result.rows[0].created);
        setTimeout(function () {
          updateConversationModifiedTime(req.p.zid, createdTimeMillis);
        }, 100);

        res.status(200).json({}); // TODO don't stop after the first one, map the inserts to deferreds.
      }
    );
  }

  function handle_GET_contexts(req: ExpressRequest, res: ExpressResponse) {
    pg.queryP_readOnly(
      "select name from contexts where is_public = TRUE order by name;",
      []
    )
      .then(
        function (contexts: any) {
          res.status(200).json(contexts);
        },
        function (err: any) {
          failJson(res, 500, "polis_err_get_contexts_query", err);
        }
      )
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_get_contexts_misc", err);
      });
  }

  function handle_POST_contexts(
    req: { p: { uid?: any; name: any } },
    res: ExpressResponse
  ) {
    const uid = req.p.uid;
    const name = req.p.name;

    function createContext() {
      return pg
        .queryP(
          "insert into contexts (name, creator, is_public) values ($1, $2, $3);",
          [name, uid, true]
        )
        .then(
          function () {
            res.status(200).json({});
          },
          function (err: any) {
            failJson(res, 500, "polis_err_post_contexts_query", err);
          }
        )
        .catch(function (err: any) {
          failJson(res, 500, "polis_err_post_contexts_misc", err);
        });
    }
    pg.queryP("select name from contexts where name = ($1);", [name])
      .then(
        function (rows: string | any[]) {
          const exists = rows && rows.length;
          if (exists) {
            failJson(res, 422, "polis_err_post_context_exists");
            return;
          }
          return createContext();
        },
        function (err: any) {
          failJson(res, 500, "polis_err_post_contexts_check_query", err);
        }
      )
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_post_contexts_check_misc", err);
      });
  }

  function handle_POST_sendCreatedLinkToEmail(
    req: { p: { uid?: any; zid: string; conversation_id: string } },
    res: ExpressResponse
  ) {
    pg.query_readOnly(
      "SELECT * FROM users WHERE uid = $1",
      [req.p.uid],
      function (err: any, results: { rows: UserType[] }) {
        if (err) {
          failJson(res, 500, "polis_err_get_email_db", err);
          return;
        }
        const email = results.rows[0].email;
        const fullname = results.rows[0].hname;

        // Use the original conversation_id (zinvite) that was passed to the endpoint
        // instead of querying for any zinvite with this zid, which could return a different one
        const zinvite = req.p.conversation_id;
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
            failJson(res, 500, "polis_err_sending_created_link_to_email", err);
          });
      }
    );
  }

  function handle_POST_sendEmailExportReady(
    req: {
      p: {
        webserver_pass: string | undefined;
        webserver_username: string | undefined;
        email: any;
        conversation_id: string;
        filename: any;
      };
    },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): void; new (): any };
      };
    }
  ) {
    if (
      req.p.webserver_pass !== Config.webserverPass ||
      req.p.webserver_username !== Config.webserverUsername
    ) {
      return failJson(res, 403, "polis_err_sending_export_link_to_email_auth");
    }

    const serverUrl = Config.getServerUrl();
    const email = req.p.email;
    const subject =
      "Polis data export for conversation pol.is/" + req.p.conversation_id;
    const fromAddress = `Polis Team <${Config.adminEmailDataExport}>`;
    const body = `Greetings

You created a data export for conversation ${serverUrl}/${req.p.conversation_id} that has just completed. You can download the results for this conversation at the following url:

${serverUrl}/api/v3/dataExport/results?filename=${req.p.filename}&conversation_id=${req.p.conversation_id}

Please let us know if you have any questions about the data.

Thanks for using Polis!
`;

    sendTextEmail(fromAddress, email, subject, body)
      .then(function () {
        res.status(200).json({});
      })
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_sending_export_link_to_email", err);
      });
  }

  function getSocialParticipantsForMod_timed(
    zid?: number,
    limit?: any,
    mod?: any,
    convOwner?: any
  ) {
    return getSocialParticipantsForMod
      .apply(null, [zid, limit, mod, convOwner])
      .then(function (results: any) {
        return results;
      });
  }

  function getSocialParticipantsForMod(
    zid: number,
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
      // "final_set.priority, " +
      "final_set.mod, " +
      "xids_subset.x_profile_image_url as x_profile_image_url, " +
      "xids_subset.xid as xid, " +
      "xids_subset.x_name as x_name, " +
      "final_set.pid " +
      "from final_set " +
      "left join xids_subset on final_set.uid = xids_subset.uid " +
      ") " +
      "select * from all_rows where (xid is not null) " +
      ";";
    return pg.queryP(q, params);
  }

  function getLocationsForParticipants(zid: number) {
    return pg.queryP_readOnly(
      "select * from participant_locations where zid = ($1);",
      [zid]
    );
  }

  function handle_GET_locations(
    req: { p: { zid: number; gid: any } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: any): void; new (): any };
      };
    }
  ) {
    const zid = req.p.zid;
    const gid = req.p.gid;

    Promise.all([getPidsForGid(zid, gid, -1), getLocationsForParticipants(zid)])
      .then(function (o: any[]) {
        const pids = o[0];
        let locations = o[1];
        locations = locations.filter(function (locData: { pid: number }) {
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
        failJson(res, 500, "polis_err_locations_01", err);
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

  function handle_PUT_ptptois(
    req: { p: { zid: number; uid?: number; pid: number; mod: any } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): void; new (): any };
      };
    }
  ) {
    const zid = req.p.zid;
    const uid = req.p.uid;
    const pid = req.p.pid;
    const mod = req.p.mod;
    isModerator(zid, uid)
      .then(function (isMod: any) {
        if (!isMod) {
          failJson(res, 403, "polis_err_ptptoi_permissions_123");
          return;
        }
        return pg
          .queryP(
            "update participants set mod = ($3) where zid = ($1) and pid = ($2);",
            [zid, pid, mod]
          )
          .then(function () {
            res.status(200).json({});
          });
      })
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_ptptoi_misc_234", err);
      });
  }
  function handle_GET_ptptois(
    req: {
      p: { zid: number; mod: any; uid?: number; conversation_id: string };
    },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: any): void; new (): any };
      };
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
        failJson(res, 500, "polis_err_ptptoi_misc", err);
      });
  }

  function doSendEinvite(req: any, email: any) {
    return generateTokenP(30, false).then(function (einvite: any) {
      return pg
        .queryP("insert into einvites (email, einvite) values ($1, $2);", [
          email,
          einvite,
        ])
        .then(function () {
          return sendEinviteEmail(req, email, einvite);
        });
    });
  }

  function handle_POST_einvites(
    req: { p: { email: any } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: {}): void; new (): any };
      };
    }
  ) {
    const email = req.p.email;
    doSendEinvite(req, email)
      .then(function () {
        res.status(200).json({});
      })
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_sending_einvite", err);
      });
  }

  function handle_GET_einvites(
    req: { p: { einvite: any } },
    res: {
      status: (arg0: number) => {
        (): any;
        new (): any;
        json: { (arg0: any): void; new (): any };
      };
    }
  ) {
    const einvite = req.p.einvite;

    pg.queryP("select * from einvites where einvite = ($1);", [einvite])
      .then(function (rows: string | any[]) {
        if (!rows.length) {
          throw new Error("polis_err_missing_einvite");
        }
        res.status(200).json(rows[0]);
      })
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_fetching_einvite", err);
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

    pg.queryP(
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
        failJson(res, 500, "polis_err_POST_contributors_misc", err);
      }
    );
  }

  function handle_GET_testConnection(
    req: ExpressRequest,
    res: ExpressResponse
  ) {
    res.status(200).json({
      status: "ok",
    });
  }

  function handle_GET_testDatabase(req: ExpressRequest, res: ExpressResponse) {
    pg.queryP("select uid from users limit 1", []).then(
      () => {
        res.status(200).json({
          status: "ok",
        });
      },
      (err: any) => {
        failJson(res, 500, "polis_err_testDatabase", err);
      }
    );
  }

  // serve up index.html in response to anything starting with a number
  const hostname: string = Config.staticFilesHost;
  const staticFilesAdminPort: number = Config.staticFilesAdminPort;

  function fetchIndexWithoutPreloadData(req: any, res: any, port: any) {
    return fetchIndex(req, res, {}, port);
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

  const handle_GET_conditionalIndexFetcher = (function () {
    return function (req: any, res: { redirect: (arg0: string) => void }) {
      if (Config.authIssuer) {
        // OIDC is configured - serve the admin page and let client-side handle auth
        // @ts-ignore - Legacy Express v3 response type mismatch
        return fetchIndexForAdminPage(req, res);
      } else if (!browserSupportsPushState(req)) {
        // TEMPORARY: Don't show the landing page.
        // The problem is that /user/create redirects to #/user/create,
        // which ends up here, and since there's no auth token yet,
        // we would show the lander. One fix would be to serve up the auth page
        // as a separate html file, and not rely on JS for the routing.
        //
        // @ts-ignore - Legacy Express v3 response type mismatch
        return fetchIndexForAdminPage(req, res);
      } else {
        // No OIDC configured - this shouldn't happen in production
        // Redirect to landing page
        logger.warn("No OIDC configured - redirecting to landing page");
        const url = getServerNameWithProtocol(req) + "/home";
        res.redirect(url);
      }
    };
  })();

  const returnObject: any = {
    // app helpers
    fetchIndexForAdminPage,
    fetchIndexForReportPage,
    fetchIndexWithoutPreloadData,
    haltOnTimeout,
    redirectIfHasZidButNoConversationId,
    // handlers
    handle_GET_conditionalIndexFetcher,
    handle_GET_contexts,
    handle_GET_dummyButton,
    handle_GET_einvites,
    handle_GET_locations,
    handle_GET_perfStats,
    handle_GET_ptptois,
    handle_GET_snapshot,
    handle_GET_testConnection,
    handle_GET_testDatabase,
    handle_GET_verification,
    handle_GET_zinvites,
    handle_POST_contexts,
    handle_POST_contributors,
    handle_POST_einvites,
    handle_POST_metrics,
    handle_POST_ptptCommentMod,
    handle_POST_sendCreatedLinkToEmail,
    handle_POST_sendEmailExportReady,
    handle_POST_stars,
    handle_POST_trashes,
    handle_POST_tutorial,
    handle_POST_upvotes,
    handle_POST_zinvites,
    handle_PUT_ptptois,
  };
  return returnObject;
} // End of initializePolisHelpers

export { initializePolisHelpers };

export default { initializePolisHelpers };
