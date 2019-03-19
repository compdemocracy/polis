const polisConfig = require('./polis-config');
const _ = require('underscore');

const errorNotifications = (function () {
  let errors = [];

  function sendAll() {
    if (errors.length === 0) {
      return;
    }
    // pushoverInstance.send({
    //     title: "err",
    //     message: _.uniq(errors).join("\n"),
    // }, function(err, result) {
    //     winston.log("info","pushover " + err?"failed":"ok");
    //     winston.log("info",err);
    //     winston.log("info",result);
    // });
    errors = [];
  }

  setInterval(sendAll, 60 * 1000);
  return {
    add: function (token) {
      if (polisConfig.isDevMode() && !_.isString(token)) {
        throw new Error("empty token for pushover");
      }
      console.error(token);
      errors.push(token);
    },
  };
}());

const yell = errorNotifications.add;

function fail(res, httpCode, clientVisibleErrorString, err) {
  emitTheFailure(res, httpCode, "polis_err", clientVisibleErrorString, err);
  yell(clientVisibleErrorString);
}

function userFail(res, httpCode, clientVisibleErrorString, err) {
  emitTheFailure(res, httpCode, "polis_user_err", clientVisibleErrorString, err);
}

function emitTheFailure(res, httpCode, extraErrorCodeForLogs, clientVisibleErrorString, err) {
  console.error(clientVisibleErrorString, extraErrorCodeForLogs, err);
  if (err && err.stack) {
    console.error(err.stack);
  }
  res.writeHead(httpCode || 500);
  res.end(clientVisibleErrorString);
}

module.exports = {
  yell,
  fail,
  userFail
};