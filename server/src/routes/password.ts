import Session from "../session";
import logger from "../utils/logger";
import fail from "../utils/fail";
import {
  queryP as pgQueryP,
  queryP_readOnly as pgQueryP_readOnly,
} from "../db/pg-query";
import { generateHashedPassword } from "../auth/password";
import Config from "../config";
import cookies from "../utils/cookies";
import User from "../user";
import emailSenders from "../email/senders";

const sendTextEmail = emailSenders.sendTextEmail;

const getUidForPwResetToken = Session.getUidForPwResetToken;
const clearPwResetToken = Session.clearPwResetToken;
const getServerNameWithProtocol = Config.getServerNameWithProtocol;
const setupPwReset = Session.setupPwReset;
const polisFromAddress = Config.polisFromAddress;
const getUserInfoForUid = User.getUserInfoForUid;

function sendPasswordResetEmail(
  uid?: any,
  pwresettoken?: any,
  serverName?: any,
  callback?: { (err: any): void; (arg0?: string): void }
) {
  getUserInfoForUid(
    uid,
    //     Argument of type '(err: any, userInfo: { hname: any; email: any; }) => void' is not assignable to parameter of type '(arg0: null, arg1?: undefined) => void'.
    // Types of parameters 'userInfo' and 'arg1' are incompatible.
    //     Type 'undefined' is not assignable to type '{ hname: any; email: any; }'.ts(2345)
    // @ts-ignore
    function (err: any, userInfo: { hname: any; email: any }) {
      if (err) {
        return callback?.(err);
      }
      if (!userInfo) {
        return callback?.("missing user info");
      }
      let body = `Hi ${userInfo.hname},

We have just received a password reset request for ${userInfo.email}

To reset your password, visit this page:
${serverName}/pwreset/${pwresettoken}

"Thank you for using Polis`;

      sendTextEmail(
        polisFromAddress,
        userInfo.email,
        "Polis Password Reset",
        body
      )
        .then(function () {
          callback?.();
        })
        .catch(function (err: any) {
          logger.error("polis_err_failed_to_email_password_reset_code", err);
          callback?.(err);
        });
    }
  );
}

function getUidByEmail(email: string) {
  email = email.toLowerCase();
  return pgQueryP_readOnly(
    "SELECT uid FROM users where LOWER(email) = ($1);",
    [email]
    // Argument of type '(rows: string | any[]) => any' is not assignable to parameter of type '(value: unknown) => any'.
    //   Types of parameters 'rows' and 'value' are incompatible.
    //     Type 'unknown' is not assignable to type 'string | any[]'.
    //       Type 'unknown' is not assignable to type 'any[]'.ts(2345)
    // @ts-ignore
  ).then(function (rows: string | any[]) {
    if (!rows || !rows.length) {
      throw new Error("polis_err_no_user_matching_email");
    }
    return rows[0].uid;
  });
}

function handle_POST_auth_password(
  req: { p: { pwresettoken: any; newPassword: any } },
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
  let pwresettoken = req.p.pwresettoken;
  let newPassword = req.p.newPassword;

  getUidForPwResetToken(
    pwresettoken,
    //     Argument of type '(err: any, userParams: { uid?: any; }) => void' is not assignable to parameter of type '(arg0: number | null, arg1?: { uid: any; } | undefined) => void'.
    // Types of parameters 'userParams' and 'arg1' are incompatible.
    //   Type '{ uid: any; } | undefined' is not assignable to type '{ uid?: any; }'.
    //     Type 'undefined' is not assignable to type '{ uid?: any; }'.ts(2345)
    // @ts-ignore
    function (err: any, userParams: { uid?: any }) {
      if (err) {
        fail(
          res,
          500,
          "Password Reset failed. Couldn't find matching pwresettoken.",
          err
        );
        return;
      }
      let uid = Number(userParams.uid);
      generateHashedPassword(
        newPassword,
        function (err: any, hashedPassword: any) {
          return pgQueryP(
            "insert into jianiuevyew (uid, pwhash) values " +
              "($1, $2) on conflict (uid) " +
              "do update set pwhash = excluded.pwhash;",
            [uid, hashedPassword]
          ).then(
            (rows: any) => {
              res.status(200).json("Password reset successful.");
              clearPwResetToken(pwresettoken, function (err: any) {
                if (err) {
                  logger.error("polis_err_auth_pwresettoken_clear_fail", err);
                }
              });
            },
            (err: any) => {
              fail(res, 500, "Couldn't reset password.", err);
            }
          );
        }
      );
    }
  );
}

function handle_POST_auth_pwresettoken(
  req: { p: { email: any } },
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
  let email = req.p.email;

  let server = getServerNameWithProtocol(req);

  // let's clear the cookies here, in case something is borked.
  cookies.clearCookies(req, res);

  function finish() {
    res.status(200).json("Password reset email sent, please check your email.");
  }

  getUidByEmail(email).then(
    function (uid?: any) {
      setupPwReset(uid, function (err: any, pwresettoken: any) {
        sendPasswordResetEmail(uid, pwresettoken, server, function (err: any) {
          if (err) {
            fail(res, 500, "Error: Couldn't send password reset email.", err);
            return;
          }
          finish();
        });
      });
    },
    function () {
      sendPasswordResetEmailFailure(email, server);
      finish();
    }
  );
}

function sendPasswordResetEmailFailure(email: any, server: any) {
  let body = `We were unable to find a pol.is account registered with the email address: ${email}

You may have used another email address to create your account.

If you need to create a new account, you can do that here ${server}/home

Feel free to reply to this email if you need help.`;

  return sendTextEmail(polisFromAddress, email, "Password Reset Failed", body);
}

export { handle_POST_auth_password, handle_POST_auth_pwresettoken };
