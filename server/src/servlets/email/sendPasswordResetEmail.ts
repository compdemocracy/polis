export default function sendPasswordResetEmail(
  uid?: any,
  pwresettoken?: any,
  serverName?: any,
  callback?: { (err: any): void; (arg0?: string): void }
) {
  getUserInfoForUid(
    uid,
    function (err: any, userInfo: { hname: any; email: any }) {
      if (err) {
        return callback?.(err);
      }
      if (!userInfo) {
        return callback?.("missing user info");
      }
      const body = `Hi ${userInfo.hname},

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
          yell("polis_err_failed_to_email_password_reset_code");
          callback?.(err);
        });
    }
  );
}
