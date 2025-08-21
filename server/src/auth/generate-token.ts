import crypto from "crypto";

type TokenCallback = (err: unknown, token?: string) => void;

function generateToken(
  len: number,
  pseudoRandomOk: boolean,
  callback: TokenCallback
) {
  // TODO store up a buffer of random bytes sampled at random times to reduce predictability. (or see if crypto module does this for us)
  // TODO if you want more readable tokens, see ReadableIds
  const gen: (
    size: number,
    cb: (err: Error | null, buf: Buffer) => void
  ) => void = pseudoRandomOk ? crypto.pseudoRandomBytes : crypto.randomBytes;
  gen(len, function (err: Error | null, buf: Buffer) {
    if (err) {
      return callback(err);
    }

    let prettyToken = buf
      .toString("base64")
      .replace(/\//g, "A")
      .replace(/\+/g, "B") // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B. Don't want to use any punctuation.)
      .replace(/l/g, "C") // looks like '1'
      .replace(/L/g, "D") // looks like '1'
      .replace(/o/g, "E") // looks like 0
      .replace(/O/g, "F") // looks lke 0
      .replace(/1/g, "G") // looks like 'l'
      .replace(/0/g, "H") // looks like 'O'
      .replace(/I/g, "J") // looks like 'l'
      .replace(/g/g, "K") // looks like 'g'
      .replace(/G/g, "M") // looks like 'g'
      .replace(/q/g, "N") // looks like 'q'
      .replace(/Q/g, "R"); // looks like 'q'
    // replace first character with a number between 2 and 9 (avoiding 0 and 1 since they look like l and O)
    prettyToken = crypto.randomInt(2, 10) + prettyToken.slice(1);
    prettyToken = prettyToken.toLowerCase();
    prettyToken = prettyToken.slice(0, len); // in case it's too long

    callback(0, prettyToken);
  });
}

function generateTokenP(len: number, pseudoRandomOk: boolean): Promise<string> {
  return new Promise(function (resolve, reject) {
    generateToken(len, pseudoRandomOk, function (err: unknown, token?: string) {
      if (err) {
        reject(err);
      } else if (typeof token === "string") {
        resolve(token);
      } else {
        reject(new Error("Token generation returned no token"));
      }
    });
  });
}

function generateRandomCode(length = 10): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return out;
}

// Helpers for login code generation and storage
function generateLoginCode(length = 16): string {
  // Use a larger alphabet for participant login codes
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // exclude ambiguous chars
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return out;
}

export { generateToken, generateTokenP, generateRandomCode, generateLoginCode };
