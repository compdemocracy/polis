export default function handle_POST_auth_deregister(
  req: { p: { showPage?: any }; cookies: { [x: string]: any } },
  res: {
    status: (
      arg0: number
    ) => {
      (): any;
      new (): any;
      end: { (): void; new (): any };
      send: { (arg0: string): void; new (): any };
    };
    set: (arg0: { "Content-Type": string }) => void;
  }
) {
  req.p = req.p || {};
  const token = req.cookies[COOKIES.TOKEN];

  // clear cookies regardless of auth status
  clearCookies(req, res);

  function finish() {
    if (!req.p.showPage) {
      res.status(200).end();
    } else if (req.p.showPage === "canvas_assignment_deregister") {
      res.set({
        "Content-Type": "text/html",
      });
      const html = `<!DOCTYPE html><html lang='en'>
<body>
<h1>You are now signed out of pol.is</h1>
<p>Please return to the 'setup pol.is' assignment to sign in as another user.</p>
</body></html>`;
      res.status(200).send(html);
    }
  }
  if (!token) {
    // nothing to do
    return finish();
  }
  endSession(token, function (err: any, data: any) {
    if (err) {
      fail(res, 500, "couldn't end session", err);
      return;
    }
    finish();
  });
}
