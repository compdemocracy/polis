import _ from "underscore";

import Config from "./config";

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
    add: function (token: any) {
      if (Config.isDevMode() && !_.isString(token)) {
        throw new Error("empty token for pushover");
      }
      console.error(token);
      errors.push(token);
    },
  };
})();

const yell = errorNotifications.add;

function fail(
  res: any,
  httpCode: any,
  clientVisibleErrorString: any,
  err: any
) {
  emitTheFailure(res, httpCode, "polis_err", clientVisibleErrorString, err);
  yell(clientVisibleErrorString);
}

function userFail(
  res: any,
  httpCode: any,
  clientVisibleErrorString: any,
  err: any
) {
  emitTheFailure(
    res,
    httpCode,
    "polis_user_err",
    clientVisibleErrorString,
    err
  );
}

function emitTheFailure(
  res: { writeHead: (arg0: any) => void; end: (arg0: any) => void },
  httpCode: any,
  extraErrorCodeForLogs: string,
  clientVisibleErrorString: any,
  err: { stack: any }
) {
  console.error(clientVisibleErrorString, extraErrorCodeForLogs, err);
  if (err && err.stack) {
    console.error(err.stack);
  }
  res.writeHead(httpCode || 500);
  res.end(clientVisibleErrorString);
}

export { yell, fail, userFail };
