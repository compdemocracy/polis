import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import _ from 'underscore';
import pg from '../db/pg-query.js';
function generateHashedPassword(password, callback) {
  bcrypt.genSalt(12, function (errSalt, salt) {
    if (errSalt) {
      return callback('polis_err_salt');
    }
    bcrypt.hash(password, salt, function (errHash, hashedPassword) {
      if (errHash) {
        return callback('polis_err_hash');
      }
      callback(null, hashedPassword);
    });
  });
}
function checkPassword(uid, password) {
  return pg
    .queryP_readOnly_wRetryIfEmpty('select pwhash from jianiuevyew where uid = ($1);', [uid])
    .then(function (rows) {
      if (!rows || !rows.length) {
        return null;
      } else if (!rows[0].pwhash) {
        return;
      }
      let hashedPassword = rows[0].pwhash;
      return new Promise(function (resolve, reject) {
        bcrypt.compare(password, hashedPassword, function (errCompare, result) {
          if (errCompare) {
            reject(errCompare);
          } else {
            resolve(result ? 'ok' : 0);
          }
        });
      });
    });
}
function generateToken(len, pseudoRandomOk, callback) {
  let gen;
  if (pseudoRandomOk) {
    gen = crypto.pseudoRandomBytes;
  } else {
    gen = crypto.randomBytes;
  }
  gen(len, function (err, buf) {
    if (err) {
      return callback(err);
    }
    let prettyToken = buf
      .toString('base64')
      .replace(/\//g, 'A')
      .replace(/\+/g, 'B')
      .replace(/l/g, 'C')
      .replace(/L/g, 'D')
      .replace(/o/g, 'E')
      .replace(/O/g, 'F')
      .replace(/1/g, 'G')
      .replace(/0/g, 'H')
      .replace(/I/g, 'J')
      .replace(/g/g, 'K')
      .replace(/G/g, 'M')
      .replace(/q/g, 'N')
      .replace(/Q/g, 'R');
    prettyToken = _.random(2, 9) + prettyToken.slice(1);
    prettyToken = prettyToken.toLowerCase();
    prettyToken = prettyToken.slice(0, len);
    callback(0, prettyToken);
  });
}
function generateTokenP(len, pseudoRandomOk) {
  return new Promise(function (resolve, reject) {
    generateToken(len, pseudoRandomOk, function (err, token) {
      if (err) {
        reject(err);
      } else {
        resolve(token);
      }
    });
  });
}
export { generateHashedPassword, checkPassword, generateToken, generateTokenP };
export default {
  generateHashedPassword,
  checkPassword,
  generateToken,
  generateTokenP
};
