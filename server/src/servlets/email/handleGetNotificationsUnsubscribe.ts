export default function handle_GET_notifications_unsubscribe(
  req: {
    p: { [x: string]: any; zid: any; email: any; conversation_id: any };
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
        return pgQueryP(
          "update participants set subscribed = 0 where uid = (select uid from users where email = ($2)) and zid = ($1);",
          [zid, email]
        ).then(function () {
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
        fail(res, 403, "polis_err_unsubscribe_signature_mismatch");
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_unsubscribe_misc", err);
    });
}