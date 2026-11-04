require("./clientErrorReporter");
var URLs = require("./url");
var report = typeof window === "undefined" ? function () {} : window.PolisClientErrors.install({
  client: "participation", build: (process.env.POLIS_BUILD_INFO || {}).commit, apiBase: URLs.urlPrefix
});
module.exports.reportClientFetch = function (error, resource) {
  try {
    if (error && error.name === "SyntaxError") report("fetch", { message: "SyntaxError: Invalid JSON", stack: error.stack }, resource);
  } catch { /* Reporting must not affect the application. */ }
};
