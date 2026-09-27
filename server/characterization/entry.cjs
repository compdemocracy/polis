"use strict";
const fs = require("node:fs"),
  http = require("node:http"),
  crypto = require("node:crypto");
const state = require("./observe.cjs");
require("ts-node/register/transpile-only");
// Generated ephemeral signing keys are never written to the corpus or filesystem.
const pair = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.JWT_PRIVATE_KEY = pair.privateKey;
process.env.JWT_PUBLIC_KEY = pair.publicKey;
function files(dir = process.cwd()) {
  const result = {};
  function visit(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (
        ["node_modules", "dist", ".git", "characterization", "source"].includes(
          e.name
        ) ||
        (p === dir && ["src", "app.ts", "index.ts"].includes(e.name))
      )
        continue;
      const f = `${p}/${e.name}`;
      if (e.isDirectory()) visit(f);
      else if (e.isFile())
        result[f.slice(dir.length + 1)] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(f))
          .digest("hex");
    }
  }
  visit(dir);
  return result;
}
const initialFiles = files();
const { default: app, appReady } = require("../app.ts");
async function main() {
  await appReady;
  await require("../src/utils/moderation.ts").moderationReady;
  if (!app.routes.get?.length) throw Error("app initialization failed");
  state.ready = true;
  const boot = {
    filesBefore: initialFiles,
    filesAfter: files(),
    outbound: [...state.outbound],
    process: [...state.process],
    notificationLoop:
      require("../src/routes/notify.ts").isNotificationLoopStarted(),
  };
  const handle = app.handle;
  app.handle = function (req, res, ...rest) {
    const owner = state.currentCase;
    if (owner?.startsWith("comments-read/"))
      res.once("finish", () => {
        state.commentsContext = Object.fromEntries(
          [
            "uid",
            "pid",
            "zid",
            "rid",
            "tids",
            "moderation",
            "mod",
            "modIn",
            "mod_gt",
            "include_voting_patterns",
            "limit",
            "offset",
          ]
            .filter((k) => req.p?.[k] !== undefined)
            .map((k) => [k, req.p[k]])
        );
      });
    // Body-parser and stream continuations arrive on reused HTTP sockets. Their
    // request/response emitters must retain this request's ownership too.
    for (const target of [req, res]) {
      const emit = target.emit;
      target.emit = function (...args) {
        return state.barrier.run(owner, () => emit.apply(this, args));
      };
    }
    return state.barrier.run(state.currentCase, () =>
      handle.call(this, req, res, ...rest)
    );
  };
  app.listen(5000, "0.0.0.0");
  http
    .createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      try {
        if (req.url.startsWith("/begin?")) {
          const seed = new URL(req.url, "http://localhost").searchParams.get(
            "seed"
          );
          if (!/^[a-f0-9]{12}$/.test(seed || ""))
            throw Error("invalid case entropy seed");
          const owner = new URL(req.url, "http://localhost").searchParams.get(
            "case"
          );
          state.currentCase = owner;
          state.commentsContext = null;
          state.caseStart = performance.now();
          state.setSeed(seed);
          return res.end("{}");
        }
        if (req.url === "/barrier")
          return res.end(
            JSON.stringify({ name: state.barrier.finish(state.currentCase) })
          );
        if (req.url === "/public-key")
          return res.end(JSON.stringify({ publicKey: pair.publicKey }));
        if (req.url === "/ready")
          return res.end(
            JSON.stringify({
              ready: state.ready,
              serialization: require("./serialization.cjs").profile(app),
              runtime: {
                node: process.version,
                exemptions: require("./barrier.cjs").exemptions,
              },
              routes: Object.values(app.routes)
                .flat()
                .map((r) => r.__p027),
              boot,
              middleware: state.middleware,
            })
          );
        if (req.url === "/state")
          return res.end(
            JSON.stringify({
              outbound: state.outbound,
              process: state.process,
              hits: state.hits,
              work: state.barrier.state(state.currentCase),
              commentsContext: state.commentsContext,
              jwtIssues: state.jwtIssues,
              files: files(),
            })
          );
        if (req.url === "/tokens") {
          const participant =
            require("../src/auth/anonymous-jwt.ts").issueAnonymousJWT(
              "2p027generated",
              3,
              2
            );
          const oidc = async (username) => {
            const response = await fetch(
              "https://oidc-simulator:3000/oauth/token",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  grant_type: "password",
                  username,
                  password: "Te$tP@ssw0rd*",
                  client_id: "dev-client-id",
                  audience: "users",
                  scope: "openid profile email",
                }),
              }
            );
            if (!response.ok)
              throw Error(`OIDC simulator token failed: ${response.status}`);
            return (await response.json()).access_token;
          };
          return res.end(
            JSON.stringify({
              participant,
              ...Object.fromEntries(
                require("./pca2-fixtures.json")
                  .filter((f) => f.auth === "participant")
                  .map((f) => [
                    `participant-${f.zid}`,
                    require("../src/auth/anonymous-jwt.ts").issueAnonymousJWT(
                      f.capability,
                      3,
                      2
                    ),
                  ])
              ),
              ...Object.fromEntries(
                await Promise.all(
                  require("./comments-cases.cjs").actors.map(async (a) => [
                    a.ref,
                    await oidc(a.username),
                  ])
                )
              ),
              ...Object.fromEntries(
                require("./comments-cases.cjs").fixtures.flatMap((f) => {
                  const token =
                    require("../src/auth/anonymous-jwt.ts").issueAnonymousJWT(
                      f.capability,
                      3,
                      f.participantPid
                    );
                  const claims = JSON.parse(
                    Buffer.from(token.split(".")[1], "base64url")
                  );
                  claims.iat -= 31536001;
                  claims.exp -= 31536001;
                  const expired = require("jsonwebtoken").sign(
                    claims,
                    pair.privateKey,
                    { algorithm: "RS256" }
                  );
                  return [
                    [`comments-participant-${f.zid}`, token],
                    [`comments-expired-${f.zid}`, expired],
                  ];
                })
              ),
              owner: await oidc("test.user.0@polis.test"),
              admin: await oidc("admin@polis.test"),
            })
          );
        }
        if (
          ["/hang-route", "/error-route", "/exit-route"].includes(req.url) &&
          process.env.P027_NEGATIVE_CONTROLS === "1"
        ) {
          const route = app.routes.get.find(
            (r) => r.path === "/api/v3/testConnection"
          );
          const behavior = req.url;
          route.callbacks[route.callbacks.length - 1] = (request, response) => {
            if (behavior === "/hang-route") return;
            if (behavior === "/exit-route") {
              setImmediate(() => {
                throw new Error("P027_NEGATIVE_EXIT");
              });
              return;
            }
            response.json({ generated: true });
            Promise.reject(new Error("P027_NEGATIVE_PROCESS_ERROR"));
          };
          return res.end("{}");
        }
        if (
          req.url === "/drop-route" &&
          process.env.P027_NEGATIVE_CONTROLS === "1"
        ) {
          app.routes.get = app.routes.get.filter(
            (r) => r.path !== "/api/v3/testConnection"
          );
          return res.end("{}");
        }
        res.statusCode = 404;
        res.end("{}");
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    })
    .listen(5001, "0.0.0.0");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
