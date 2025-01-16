import cookies from "../utils/cookies";
const COOKIES = cookies.COOKIES;

function handle_GET_tryCookie(
  req: { headers?: { origin: string }; cookies: { [x: string]: any } },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  if (!req.cookies[COOKIES.TRY_COOKIE]) {
    // Argument of type '{ status: (arg0: number) => { (): any; new (): any; json:
    // { (arg0: {}): void; new (): any; }; }; }' is not assignable to parameter of type
    // '{ cookie: (arg0: any, arg1: any, arg2: any) => void; }'.
    //   Property 'cookie' is missing in type '{ status: (arg0: number) =>
    // { (): any; new (): any; json: { (arg0: {}): void; new (): any; }; };
    // } ' but required in type '{ cookie: (arg0: any, arg1: any, arg2: any) => void; } '.ts(2345)
    // @ts-ignore
    setCookie(req, res, COOKIES.TRY_COOKIE, "ok", {
      httpOnly: false, // not httpOnly - needed by JS
    });
  }
  res.status(200).json({});
}

export default handle_GET_tryCookie;
