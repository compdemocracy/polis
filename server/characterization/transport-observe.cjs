"use strict";
const { AsyncResource } = require("node:async_hooks");
// Observe data emission without adding a data listener: a listener would put an
// SDK's response into flowing mode before its asynchronous deserializer attaches.
function observeResponse(req, attempt, finish) {
  req.on(
    "response",
    AsyncResource.bind((res) => {
      const parts = [],
        emit = res.emit;
      res.emit = AsyncResource.bind(function (event, ...args) {
        if (event === "data")
          parts.push(Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0]));
        if (event === "end") {
          attempt.response = Buffer.concat(parts).toString("utf8");
          attempt.termination = "end";
          finish();
        }
        if (event === "error" || event === "aborted") {
          attempt.termination = "connection_error";
          finish();
        }
        return emit.call(this, event, ...args);
      });
    })
  );
  req.on("error", () => {
    attempt.termination = "connection_error";
    finish();
  });
}
module.exports = { observeResponse };
