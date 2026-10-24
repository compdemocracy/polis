/* Test-only second Node process. The HTTP surface is the unchanged app.
 * IPC is used only for readiness, pool observations and orderly shutdown. */
require("ts-node/register/transpile-only");
const observer = require("./mixed-writer-observer.cjs");
const app = require("../../app").default;
const requests = [];
const server = app.listen(0, "127.0.0.1", () => {
  process.send({ ready: true, port: server.address().port, pid: process.pid });
});
server.on("request", (req, res) => {
  res.once("finish", () =>
    requests.push({
      method: req.method,
      path: req.url.split("?")[0],
      status: res.statusCode,
    })
  );
});
process.on("message", async (message) => {
  if (message.op === "snapshot") {
    process.send({
      id: message.id,
      ...observer.snapshot(),
      requests: requests.splice(0),
    });
  }
  if (message.op === "stop") {
    server.close(async () => {
      await observer.close();
      process.exit(0);
    });
  }
});
