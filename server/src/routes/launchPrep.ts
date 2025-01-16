import Utils from "../utils/common";
import cookies from "../utils/cookies";
import Session from "../session";
const COOKIES = cookies.COOKIES;

const setPermanentCookie = cookies.setPermanentCookie;
const setCookieTestCookie = cookies.setCookieTestCookie;
const makeSessionToken = Session.makeSessionToken;

function handle_GET_launchPrep(
  req: {
    headers?: { origin: string };
    cookies: { [x: string]: any };
    p: { dest: any };
  },
  res: { redirect: (arg0: any) => void }
) {
  if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
    setPermanentCookie(req, res, makeSessionToken());
  }
  setCookieTestCookie(req, res);

  // Argument of type '{ redirect: (arg0: any) => void; }' is not assignable to parameter of type '{ cookie: (arg0: any, arg1: any, arg2: any) => void; }'.
  // Property 'cookie' is missing in type '{ redirect: (arg0: any) => void; }' but required in type '{ cookie: (arg0: any, arg1: any, arg2: any) => void; }'.ts(2345)
  // @ts-ignore
  setCookie(req, res, "top", "ok", {
    httpOnly: false, // not httpOnly - needed by JS
  });

  // using hex since it doesn't require escaping like base64.
  const dest = Utils.hexToStr(req.p.dest);
  const url = new URL(dest);
  res.redirect(url.pathname + url.search + url.hash);
}

export default handle_GET_launchPrep;
