const bcrypt = require('bcrypt');
const pg = require('../db/pg-query');

function generateHashedPassword(password, callback) {
  bcrypt.genSalt(12, function(errSalt, salt) {
    if (errSalt) {
      return callback("polis_err_salt");
    }
    bcrypt.hash(password, salt, function(errHash, hashedPassword) {
      if (errHash) {
        return callback("polis_err_hash");
      }
      callback(null, hashedPassword);
    });
  });
}

function checkPassword(uid, password) {
  return pg.queryP_readOnly_wRetryIfEmpty("select pwhash from jianiuevyew where uid = ($1);", [uid]).then(function(rows) {
    if (!rows || !rows.length) {
      return null;
    } else if (!rows[0].pwhash) {
      return void 0;
    }
    let hashedPassword = rows[0].pwhash;
    return new Promise(function(resolve, reject) {
      bcrypt.compare(password, hashedPassword, function(errCompare, result) {
        if (errCompare) {
          reject(errCompare);
        } else {
          resolve(result ? "ok" : 0);
        }
      });
    });
  });
}

module.exports = {
  generateHashedPassword,
  checkPassword
};