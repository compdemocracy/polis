// On macOS, listen(0) can choose an IPv6 port already used by an IPv4
// listener; Supertest otherwise sends that request to 127.0.0.1. Use IPv6
// when loopback is available, preserving the original Linux request details.
// This avoids IPv4 listeners; a competing IPv6 loopback listener can still
// intercept a wildcard-bound server's requests on macOS.
const os = require("node:os");
const supertest = require("supertest/index.js");
const useIPv6Loopback =
  process.platform === "darwin" &&
  Object.values(os.networkInterfaces())
    .flat()
    .some((address) => address?.internal && address.address === "::1");

if (useIPv6Loopback) {
  const serverAddress = supertest.Test.prototype.serverAddress;
  supertest.Test.prototype.serverAddress = function (app, path) {
    const url = serverAddress.call(this, app, path);
    const address = app.address();
    if (address && typeof address === "object" && address.family === "IPv6") {
      const host = address.address === "::" ? "::1" : address.address;
      return url.replace("://127.0.0.1:", `://[${host}]:`);
    }
    return url;
  };
}

module.exports = supertest;
