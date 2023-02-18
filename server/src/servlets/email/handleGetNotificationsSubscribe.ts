export default function handle_GET_notifications_subscribe(
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
    email: req.p.email,
  };

  params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
  verifyHmacForQueryParams("api/v3/notifications/subscribe", params)
    .then(
      function () {
        return pgQueryP(
          "update participants set subscribed = 1 where uid = (select uid from users where email = ($2)) and zid = ($1);",
          [zid, email]
        ).then(function () {
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
        fail(res, 403, "polis_err_subscribe_signature_mismatch");
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_subscribe_misc", err);
    });
}