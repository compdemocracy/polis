"use strict";
// Disposable full-app probe control. The HTTP application itself is unmodified.
require("/app/characterization/entry.cjs");
const http = require("node:http");
http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/prefetch") {
      await require("/app/src/utils/pca.ts").prefetchLatestPcaData();
    } else if (url.pathname === "/participant") {
      const token = require("/app/src/auth/anonymous-jwt.ts").issueAnonymousJWT(
        url.searchParams.get("conversation"), Number(url.searchParams.get("uid")),
        Number(url.searchParams.get("pid")));
      return res.end(JSON.stringify({token}));
    } else if (url.pathname !== "/identity") {
      res.statusCode = 404;
      return res.end("{}");
    }
    res.end(JSON.stringify({math_env: require("/app/src/config.ts").default.mathEnv,
      pid: process.pid, replica: process.env.P026_READER_ID}));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({error: error.message}));
  }
}).listen(5002, "0.0.0.0");
