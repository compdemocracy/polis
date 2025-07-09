import _ from "underscore";
import crypto from "crypto";
import { encode } from "html-entities";
import { Promise as BluebirdPromise } from "bluebird";

import { emailTeam } from "../email/senders";
import { failJson } from "../utils/fail";
import { getConversationInfo } from "../conversation";
import { getNumberOfCommentsRemaining } from "../comment";
import { getZinvite } from "../utils/zinvite";
import { isPolisDev } from "../utils/common";
import { sendEmailByUid } from "../server-helpers";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";

const HMAC_SIGNATURE_PARAM_NAME = "signature";

const verifyHmacForQueryParams = (
  path: string,
  params: { [x: string]: any; conversation_id?: any; email?: any }
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const clonedParams = { ...params };
    const hash = clonedParams[HMAC_SIGNATURE_PARAM_NAME];
    delete clonedParams[HMAC_SIGNATURE_PARAM_NAME];
    const correctHash = createHmacForQueryParams(path, clonedParams);
    // To thwart timing attacks, add some randomness to the response time with setTimeout.
    setTimeout(() => {
      logger.debug("comparing", { correctHash, hash });
      if (correctHash === hash) {
        resolve();
      } else {
        reject();
      }
    });
  });
};

function paramsToStringSortedByName(params: {
  conversation_id?: any;
  email?: any;
}) {
  const pairs = _.pairs(params).sort(function (
    a: [string, any],
    b: [string, any]
  ) {
    return a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0;
  });
  const pairsList = pairs.map(function (pair: any[]) {
    return pair.join("=");
  });
  return pairsList.join("&");
}

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

function createNotificationsSubscribeUrl(conversation_id: any, email: any) {
  const params = {
    conversation_id: conversation_id,
    email: encode(email),
  };
  const path = "api/v3/notifications/subscribe";
  params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

  const server = Config.getServerUrl();
  return server + "/" + path + "?" + paramsToStringSortedByName(params);
}

function subscribeToNotifications(zid: number, uid?: number, email?: string) {
  const type = 1; // 1 for email
  logger.info("subscribeToNotifications", { zid, uid });
  return pg
    .queryP(
      "update participants_extended set subscribe_email = ($3) where zid = ($1) and uid = ($2);",
      [zid, uid, email]
    )
    .then(function () {
      return pg
        .queryP(
          "update participants set subscribed = ($3) where zid = ($1) and uid = ($2);",
          [zid, uid, type]
        )
        .then(function () {
          return type;
        });
    });
}

function unsubscribeFromNotifications(zid: number, uid?: number) {
  const type = 0; // 1 for nothing
  return pg
    .queryP(
      "update participants set subscribed = ($3) where zid = ($1) and uid = ($2);",
      [zid, uid, type]
    )
    .then(function () {
      return type;
    });
}

function maybeAddNotificationTask(zid: number, timeInMillis: number) {
  return pg.queryP(
    "insert into notification_tasks (zid, modified) values ($1, $2) on conflict (zid) do nothing;",
    [zid, timeInMillis]
  );
}

function claimNextNotificationTask() {
  return pg
    .queryP(
      "delete from notification_tasks where zid = (select zid from notification_tasks order by random() for update skip locked limit 1) returning *;"
    )
    .then((rows: string | any[]) => {
      if (!rows || !rows.length) {
        return null;
      }
      return rows[0];
    });
}

function doNotificationBatch() {
  return claimNextNotificationTask().then(
    (task: { zid: number; modified: any }) => {
      if (!task) {
        return Promise.resolve();
      }
      return doNotificationsForZid(task.zid, task.modified).then(
        (shouldTryAgain: any) => {
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

function getDbTime() {
  return pg
    .queryP("select now_as_millis();", [])
    .then((rows: { now_as_millis: any }[]) => {
      return rows[0].now_as_millis;
    });
}

function doNotificationsForZid(zid: number, timeOfLastEvent: any) {
  let shouldTryAgain = false;

  return pg
    .queryP(
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
        candidates.forEach((c: { pid: number }) => {
          pid_to_ptpt[c.pid] = c;
        });
        return BluebirdPromise.mapSeries(
          candidates,
          (item: { zid: number; pid: number }) => {
            return getNumberOfCommentsRemaining(item.zid, item.pid).then(
              (rows: any[]) => {
                return rows[0];
              }
            );
          }
        ).then((results: any[]) => {
          const needNotification = results.filter(
            (result: { pid: number; remaining: number }) => {
              const ptpt = pid_to_ptpt[result.pid];
              let needs = true;

              needs = needs && result.remaining > 0;

              // if (needs && result.remaining < 5) {
              //   // no need to try again for this user since new comments will create new tasks
              //   needs = false;
              // }

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
                needs = false;
              }

              if (needs && dbTimeMillis < ptpt.last_notified + waitTime) {
                // Limit to one per hour.
                shouldTryAgain = true;
                needs = false;
              }
              if (
                needs &&
                dbTimeMillis < ptpt.last_interaction + 5 * 60 * 1000
              ) {
                // Wait until 5 minutes after their last interaction.
                shouldTryAgain = true;
                needs = false;
              }

              if (Config.isDevMode) {
                needs = needs && isPolisDev(ptpt.uid);
              }
              return needs;
            }
          );

          if (needNotification.length === 0) {
            return null;
          }
          const pids = _.pluck(needNotification, "pid");

          return pg
            .queryP(
              "select uid, subscribe_email from participants_extended where uid in (select uid from participants where pid in (" +
                pids.join(",") +
                "));",
              []
            )
            .then((rows: any[]) => {
              const uidToEmail = {};
              rows.forEach(
                (row: { uid: string | number; subscribe_email: any }) => {
                  uidToEmail[row.uid] = row.subscribe_email;
                }
              );

              return BluebirdPromise.each(
                needNotification,
                (item: { pid: number; remaining: any }) => {
                  const uid = pid_to_ptpt[item.pid].uid;
                  return sendNotificationEmail(
                    uid,
                    url,
                    conversation_id,
                    uidToEmail[uid]
                  ).then(() => {
                    return pg.queryP(
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
    });
}

function doNotificationLoop() {
  logger.debug("doNotificationLoop");
  doNotificationBatch().then(() => {
    setTimeout(doNotificationLoop, 10000);
  });
}

function sendNotificationEmail(
  uid?: any,
  url?: string,
  conversation_id?: string,
  email?: any
) {
  const subject =
    "New statements to vote on (conversation " + conversation_id + ")"; // Not sure if putting the conversation_id is ideal, but we need some way to ensure that the notifications for each conversation appear in separte threads.
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

const shouldSendNotifications = !Config.isDevMode;
if (shouldSendNotifications) {
  doNotificationLoop();
}

function createNotificationsUnsubscribeUrl(conversation_id: any, email: any) {
  const params = {
    conversation_id: conversation_id,
    email: encode(email),
  };
  const path = "api/v3/notifications/unsubscribe";
  params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

  const server = Config.getServerUrl();
  return server + "/" + path + "?" + paramsToStringSortedByName(params);
}

function handle_GET_notifications_subscribe(
  req: {
    p: {
      [x: string]: any;
      zid: number;
      email: string;
      conversation_id: string;
    };
  },
  res: {
    set: (arg0: string, arg1: string) => void;
    send: (arg0: string) => void;
  }
) {
  const zid = req.p.zid;
  const email = req.p.email;
  const params = {
    conversation_id: req.p.conversation_id,
    email: req.p.email,
  };
  params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
  verifyHmacForQueryParams("api/v3/notifications/subscribe", params)
    .then(
      function () {
        return pg
          .queryP(
            "update participants set subscribed = 1 where uid = (select uid from users where email = ($2)) and zid = ($1);",
            [zid, email]
          )
          .then(function () {
            res.set("Content-Type", "text/html");
            res.send(
              `<h1>Subscribed!</h1>
<p>
<a href="${createNotificationsUnsubscribeUrl(
                req.p.conversation_id,
                req.p.email
              )}">oops, unsubscribe me.</a>
</p>`
            );
          });
      },
      function () {
        failJson(res, 403, "polis_err_subscribe_signature_mismatch");
      }
    )
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_subscribe_misc", err);
    });
}

function handle_GET_notifications_unsubscribe(
  req: {
    p: {
      [x: string]: any;
      zid: number;
      email: string;
      conversation_id: string;
    };
  },
  res: {
    set: (arg0: string, arg1: string) => void;
    send: (arg0: string) => void;
  }
) {
  const zid = req.p.zid;
  const email = req.p.email;
  const params = {
    conversation_id: req.p.conversation_id,
    email: email,
  };
  params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
  verifyHmacForQueryParams("api/v3/notifications/unsubscribe", params)
    .then(
      function () {
        return pg
          .queryP(
            "update participants set subscribed = 0 where uid = (select uid from users where email = ($2)) and zid = ($1);",
            [zid, email]
          )
          .then(function () {
            res.set("Content-Type", "text/html");
            res.send(
              `<h1>Unsubscribed.</h1>
<p>
<a href="${createNotificationsSubscribeUrl(
                req.p.conversation_id,
                req.p.email
              )}">oops, subscribe me again.</a>
</p>`
            );
          });
      },
      function () {
        failJson(res, 403, "polis_err_unsubscribe_signature_mismatch");
      }
    )
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_unsubscribe_misc", err);
    });
}

function handle_POST_convSubscriptions(
  req: { p: { zid: number; uid?: number; type: any; email: string } },
  res: {
    status: (arg0: number) => {
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
        failJson(res, 500, "polis_err_sub_conv " + zid + " " + uid, err);
      });
  } else if (type === 0) {
    unsubscribeFromNotifications(zid, uid)
      .then(finish)
      .catch(function (err: any) {
        failJson(res, 500, "polis_err_unsub_conv " + zid + " " + uid, err);
      });
  } else {
    failJson(
      res,
      400,
      "polis_err_bad_subscription_type",
      new Error("polis_err_bad_subscription_type")
    );
  }
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
    return failJson(res, 403, "polis_err_notifyTeam_auth");
  }
  const subject = req.p.subject;
  const body = req.p.body;
  emailTeam(subject, body)
    .then(() => {
      res.status(200).json({});
    })
    .catch((err: any) => {
      return failJson(res, 500, "polis_err_notifyTeam", err);
    });
}

export {
  handle_GET_notifications_subscribe,
  handle_GET_notifications_unsubscribe,
  handle_POST_convSubscriptions,
  handle_POST_notifyTeam,
};
