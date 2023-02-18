import bcrypt from "bcryptjs";
import crypto from "crypto";
import _ from "underscore";

import pg from "../db/pg-query";

function generateHashedPassword(
  password: any,
  callback: (arg0: string | null, arg1?: undefined) => void
) {
  bcrypt.genSalt(12, function (errSalt: any, salt: any) {
    if (errSalt) {
      return callback("polis_err_salt");
    }
    bcrypt.hash(password, salt, function (errHash: any, hashedPassword: any) {
      if (errHash) {
        return callback("polis_err_hash");
      }
      callback(null, hashedPassword);
    });
  });
}

function checkPassword(uid: any, password: any) {
  return pg
    .queryP_readOnly_wRetryIfEmpty(
      "select pwhash from jianiuevyew where uid = ($1);",
      [uid]
    )
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        return null;
      } else if (!rows[0].pwhash) {
        return void 0;
      }
      const hashedPassword = rows[0].pwhash;
      return new Promise(function (resolve, reject) {
        bcrypt.compare(
          password,
          hashedPassword,
          function (errCompare: any, result: any) {
            if (errCompare) {
              reject(errCompare);
            } else {
              resolve(result ? "ok" : 0);
            }
          }
        );
      });
    });
}

function generateToken(
  len: any,
  pseudoRandomOk: any,
  callback: {
    (err: any, token: any): void;
    (arg0: number, longStringOfTokens?: string): void;
  }
) {
  // TODO store up a buffer of random bytes sampled at random times to reduce predictability.
  // (or see if crypto module does this for us)
  // TODO if you want more readable tokens, see ReadableIds
  let gen;
  if (pseudoRandomOk) {
    gen = crypto.pseudoRandomBytes;
  } else {
    gen = crypto.randomBytes;
  }
  gen(
    len,
    function (
      err: any,
      buf: { toString: (arg0: BufferEncoding | undefined) => string }
    ) {
      if (err) {
        return callback(err);
      }

      let prettyToken = buf
        .toString("base64")
        .replace(/\//g, "A")
        // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B.
        // Don't want to use any punctuation.)
        .replace(/\+/g, "B")
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
      prettyToken = _.random(2, 9) + prettyToken.slice(1);
      prettyToken = prettyToken.toLowerCase();
      prettyToken = prettyToken.slice(0, len); // in case it's too long

      callback(0, prettyToken);
    }
  );
}

function generateTokenP(len: any, pseudoRandomOk: any) {
  return new Promise(function (resolve, reject) {
    generateToken(len, pseudoRandomOk, function (err: any, token: unknown) {
      if (err) {
        reject(err);
      } else {
        resolve(token);
      }
    });
  });
}

export default {
  generateHashedPassword,
  checkPassword,
  generateToken,
  generateTokenP,
};
