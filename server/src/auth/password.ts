import bcrypt from "bcrypt";
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
      let hashedPassword = rows[0].pwhash;
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
    (arg0: number, arg1?: undefined): void;
  }
) {
  // TODO store up a buffer of random bytes sampled at random times to reduce predictability. (or see if crypto module does this for us)
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

// function generateApiKeyForUser(uid, optionalPrefix) {
//   let parts = ["pkey"];
//   let len = 32;
//   if (!_.isUndefined(optionalPrefix)) {
//     parts.push(optionalPrefix);
//   }
//   len -= parts[0].length;
//   len -= (parts.length - 1); // the underscores
//   parts.forEach(function(part) {
//     len -= part.length;
//   });
//   return generateTokenP(len, false).then(function(token) {
//     parts.push(token);
//     let apikey = parts.join("_");
//     return apikey;
//   });
// }

// function addApiKeyForUser(uid, optionalPrefix) {
//   return generateApiKeyForUser(uid, optionalPrefix).then(function(apikey) {
//     return pg.queryP("insert into apikeysndvweifu (uid, apikey)  VALUES ($1, $2);", [uid, apikey]);
//   });
// }
// function getApiKeysTruncated(uid) {
//   return pg.queryP_readOnly("select * from apikeysndvweifu WHERE uid = ($1);", [uid]).then(function(rows) {
//     if (!rows || !rows.length) {
//       return [];
//     }
//     return rows.map(function(row) {
//       return {
//         apikeyTruncated: row.apikey.slice(0, 10) + "...",
//         created: row.created,
//       };
//     });
//   });
// }

// function createApiKey(uid) {
//   return generateTokenP(17, false).then(function(token) {
//     let apikey = "pkey_" + token;
//     return pg.queryP("insert into apikeysndvweifu (uid, apikey) values ($1, $2) returning *;", [uid, apikey]).then(function(row) {
//       return {
//         apikey: apikey,
//         created: row.created,
//       };
//     });
//   });
// }

// function deleteApiKey(uid, apikeyTruncated) {
//   // strip trailing "..."
//   apikeyTruncated = apikeyTruncated.slice(0, apikeyTruncated.indexOf("."));
//   // basic sanitizing - replace unexpected characters with x's.
//   apikeyTruncated = apikeyTruncated.replace(/[^a-zA-Z0-9_]/g, 'x');
//   return pg.queryP("delete from apikeysndvweifu where uid = ($1) and apikey ~ '^" + apikeyTruncated + "';", [uid]);
// }

// function addApiKeyForUsersBulk(uids, optionalPrefix) {
//     let promises = uids.map(function(uid) {
//         return generateApiKeyForUser(uid, optionalPrefix);
//     });
//     return Promise.all(promises).then(function(apikeys) {
//         let query = "insert into apikeysndvweifu (uid, apikey)  VALUES ";
//         let pairs = [];
//         for (var i = 0; i < uids.length; i++) {
//             let uid = uids[i];
//             let apikey = apikeys[i];
//             pairs.push("(" + uid + ', \'' + apikey + '\')');
//         }
//         query += pairs.join(',');
//         query += 'returning uid;';
//         return pg.queryP(query, []);
//     });
// }

// let uidsX = [];
// for (var i = 200200; i < 300000; i++) {
//     uidsX.push(i);
// }
// addApiKeyForUsersBulk(uidsX, "test23").then(function(uids) {
//     console.log("hihihihi", uids.length);
//     setTimeout(function() { process.exit();}, 3000);
// });

// // let time1 = Date.now();
// createDummyUsersBatch(3 * 1000).then(function(uids) {
//         // let time2 = Date.now();
//         // let dt = time2 - time1;
//         // console.log("time foo" , dt);
//         // console.dir(uids);
//         uids.forEach(function(uid) {
//             console.log("hihihihi", uid);
//         });
//         process.exit(0);

// }).catch(function(err) {
//     console.error("errorfooooo");
//     console.error(err);
// });

export { generateHashedPassword, checkPassword, generateToken, generateTokenP };

export default {
  generateHashedPassword,
  checkPassword,
  generateToken,
  generateTokenP,
};
