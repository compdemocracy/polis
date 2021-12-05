import crypto from "crypto";
import LruCache from "lru-cache";

import pg from "./db/pg-query";

function encrypt(text: string | null) {
  const algorithm = "aes-256-ctr";
  const password = process.env.ENCRYPTION_PASSWORD_00001;
  //
  // TODO replace deprecated createCipher method with current createCipheriv method
  //
  //  function createCipher(algorithm: crypto.CipherCCMTypes, password: crypto.BinaryLike, options: crypto.CipherCCMOptions): crypto.CipherCCM (+2 overloads)
  //
  // @deprecated — since v10.0.0 use createCipheriv()
  //
  // The signature '(algorithm: string, password: BinaryLike, options: TransformOptions | undefined): CipherCCM & CipherGCM & Cipher' of 'crypto.createCipher' is deprecated.ts(6387)
  // crypto.d.ts(207, 9): The declaration was marked as deprecated here.
  // No overload matches this call.
  //   Overload 1 of 3, '(algorithm: CipherGCMTypes, password: BinaryLike, options?: CipherGCMOptions | undefined): CipherGCM', gave the following error.
  //     Argument of type '"aes-256-ctr"' is not assignable to parameter of type 'CipherGCMTypes'.
  //   Overload 2 of 3, '(algorithm: string, password: BinaryLike, options?: TransformOptions | undefined): Cipher', gave the following error.
  //     Argument of type 'string | undefined' is not assignable to parameter of type 'BinaryLike'.
  //       Type 'undefined' is not assignable to type 'BinaryLike'.ts(2769)
  // @ts-ignore
  const cipher = crypto.createCipher(algorithm, password);
  // No overload matches this call.
  // Overload 1 of 4, '(data: ArrayBufferView, input_encoding: undefined, output_encoding: Encoding): string', gave the following error.
  //   Argument of type 'string | null' is not assignable to parameter of type 'ArrayBufferView'.
  //     Type 'null' is not assignable to type 'ArrayBufferView'.
  // Overload 2 of 4, '(data: string, input_encoding: Encoding | undefined, output_encoding: Encoding): string', gave the following error.
  //   Argument of type 'string | null' is not assignable to parameter of type 'string'.
  //   Type 'null' is not assignable to type 'string'.ts(2769)
  // @ts-ignore
  var crypted = cipher.update(text, "utf8", "hex");
  // Type 'string' is not assignable to type 'Buffer & string'.
  // Type 'string' is not assignable to type 'Buffer'.ts(2322)
  // @ts-ignore
  crypted += cipher.final("hex");
  return crypted;
}

function decrypt(text: string) {
  const algorithm = "aes-256-ctr";
  const password = process.env.ENCRYPTION_PASSWORD_00001;
  //
  // TODO replace deprecated createDecipher method with current createDecipheriv method
  //
  //  function createDecipher(algorithm: crypto.CipherCCMTypes, password: crypto.BinaryLike, options: crypto.CipherCCMOptions): crypto.DecipherCCM (+2 overloads)
  //
  // @deprecated — since v10.0.0 use createDecipheriv()
  //
  // The signature '(algorithm: string, password: BinaryLike, options: TransformOptions | undefined): DecipherCCM & DecipherGCM & Decipher' of 'crypto.createDecipher' is deprecated.ts(6387)
  // crypto.d.ts(253, 9): The declaration was marked as deprecated here.
  // No overload matches this call.
  //   Overload 1 of 3, '(algorithm: CipherGCMTypes, password: BinaryLike, options?: CipherGCMOptions | undefined): DecipherGCM', gave the following error.
  //     Argument of type '"aes-256-ctr"' is not assignable to parameter of type 'CipherGCMTypes'.
  //   Overload 2 of 3, '(algorithm: string, password: BinaryLike, options?: TransformOptions | undefined): Decipher', gave the following error.
  //     Argument of type 'string | undefined' is not assignable to parameter of type 'BinaryLike'.ts(2769)
  // @ts-ignore
  const decipher = crypto.createDecipher(algorithm, password);
  var dec = decipher.update(text, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}
decrypt; // appease linter
function makeSessionToken() {
  // These can probably be shortened at some point.
  return crypto
    .randomBytes(32)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .substr(0, 20);
}

// But we need to squeeze a bit more out of the db right now,
// and generally remove sources of uncertainty about what makes
// various queries slow. And having every single query talk to PG
// adds a lot of variability across the board.
const userTokenCache = new LruCache({
  max: 9000,
});

function getUserInfoForSessionToken(
  sessionToken: unknown,
  res: any,
  cb: (arg0: number | null, arg1?: unknown) => void
) {
  let cachedUid = userTokenCache.get(sessionToken);
  if (cachedUid) {
    cb(null, cachedUid);
    return;
  }
  pg.query(
    "select uid from auth_tokens where token = ($1);",
    [sessionToken],
    function (err: any, results: { rows: string | any[] }) {
      if (err) {
        console.error("token_fetch_error");
        cb(500);
        return;
      }
      if (!results || !results.rows || !results.rows.length) {
        console.error("token_expired_or_missing");

        cb(403);
        return;
      }
      let uid = results.rows[0].uid;
      userTokenCache.set(sessionToken, uid);
      cb(null, uid);
    }
  );
}

function startSession(uid: any, cb: (arg0: null, arg1?: string) => void) {
  let token = makeSessionToken();
  //console.log("info",'startSession: token will be: ' + sessionToken);
  console.log("info", "startSession");
  pg.query(
    "insert into auth_tokens (uid, token, created) values ($1, $2, default);",
    [uid, token],
    function (err: any, repliesSetToken: any) {
      if (err) {
        cb(err);
        return;
      }
      console.log("info", "startSession: token set.");
      cb(null, token);
    }
  );
}

function endSession(sessionToken: any, cb: (err: any, data?: any) => void) {
  pg.query(
    "delete from auth_tokens where token = ($1);",
    [sessionToken],
    function (err: any, results: any) {
      if (err) {
        cb(err);
        return;
      }
      cb(null);
    }
  );
}
function setupPwReset(uid: any, cb: (arg0: null, arg1?: string) => void) {
  function makePwResetToken() {
    // These can probably be shortened at some point.
    return crypto
      .randomBytes(140)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .substr(0, 100);
  }
  let token = makePwResetToken();
  pg.query(
    "insert into pwreset_tokens (uid, token, created) values ($1, $2, default);",
    [uid, token],
    function (errSetToken: any, repliesSetToken: any) {
      if (errSetToken) {
        cb(errSetToken);
        return;
      }
      cb(null, token);
    }
  );
}

function getUidForPwResetToken(
  pwresettoken: any,
  cb: (arg0: number | null, arg1?: { uid: any }) => void
) {
  // TODO "and created > timestamp - x"
  pg.query(
    "select uid from pwreset_tokens where token = ($1);",
    [pwresettoken],
    function (errGetToken: any, results: { rows: string | any[] }) {
      if (errGetToken) {
        console.error("pwresettoken_fetch_error");
        cb(500);
        return;
      }
      if (!results || !results.rows || !results.rows.length) {
        console.error("token_expired_or_missing");
        cb(403);
        return;
      }
      cb(null, {
        uid: results.rows[0].uid,
      });
    }
  );
}

function clearPwResetToken(pwresettoken: any, cb: (arg0: null) => void) {
  pg.query(
    "delete from pwreset_tokens where token = ($1);",
    [pwresettoken],
    function (errDelToken: any, repliesSetToken: any) {
      if (errDelToken) {
        cb(errDelToken);
        return;
      }
      cb(null);
    }
  );
}

export {
  encrypt,
  decrypt,
  makeSessionToken,
  getUserInfoForSessionToken,
  startSession,
  endSession,
  setupPwReset,
  getUidForPwResetToken,
  clearPwResetToken,
};

export default {
  encrypt,
  decrypt,
  makeSessionToken,
  getUserInfoForSessionToken,
  startSession,
  endSession,
  setupPwReset,
  getUidForPwResetToken,
  clearPwResetToken,
};
