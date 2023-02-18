export default function handle_GET_verification(
  req: { p: { e: any } },
  res: {
    set: (arg0: string, arg1: string) => void;
    send: (arg0: string) => void;
  }
) {
  const einvite = req.p.e;
  pgQueryP("select * from einvites where einvite = ($1);", [einvite])
    .then(function (rows: string | any[]) {
      if (!rows.length) {
        fail(res, 500, "polis_err_verification_missing");
      }
      const email = rows[0].email;
      return pgQueryP(
        "select email from email_validations where email = ($1);",
        [email]
      ).then(function (rows: string | any[]) {
        if (rows && rows.length > 0) {
          return true;
        }
        return pgQueryP(
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
      fail(res, 500, "polis_err_verification", err);
    });
}