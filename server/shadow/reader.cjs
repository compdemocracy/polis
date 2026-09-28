"use strict";

// Opt-in private reader. Import the admitted app, never its ordinary index or
// characterization entry. The supervisor still supplies a read-only filesystem,
// restricted network, least-privilege database login and pinned Node executable.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const Module = require("node:module");
const { install } = require("./snapshot-pool.cjs");
const RUNTIME_ASSETS = Object.freeze([
  "src/prompts/moderation/script.xml",
  "src/prompts/report_experimental/system.xml",
]);
const BUILD_ROOTS = Object.freeze(["dist", "package.json", "package-lock.json", ...RUNTIME_ASSETS]);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const asciiJSON = (value) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const compare = (a, b) => {
      const aa = Array.from(a, (c) => c.codePointAt(0)), bb = Array.from(b, (c) => c.codePointAt(0));
      for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
      return aa.length - bb.length;
    };
    return `{${Object.keys(value).sort(compare).map((key) => `${asciiJSON(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return asciiJSON(value);
}
function privateFile(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size > 8 * 1024 * 1024) {
      throw Error("SHADOW_PRIVATE_FILE");
    }
    const maximum = 8 * 1024 * 1024;
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maximum) throw Error("SHADOW_PRIVATE_FILE");
    return bytes.subarray(0, used);
  } catch { throw Error("SHADOW_PRIVATE_FILE"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// A symlink entry hashes its exact link text, while its internal regular-file
// target is independently included. Directory and escaping links are refused.
function entryDigest(root, relative, readonly = false) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.split("/").some((p) => !p || p === "." || p === "..")) {
    throw Error("SHADOW_BUILD");
  }
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw Error("SHADOW_BUILD");
  let ancestor = path.dirname(target);
  while (ancestor !== root) {
    const directory = fs.lstatSync(ancestor);
    if (!ancestor.startsWith(root + path.sep) || !directory.isDirectory() ||
        (readonly && (directory.mode & 0o222))) throw Error("SHADOW_BUILD");
    ancestor = path.dirname(ancestor);
  }
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink()) {
    const real = fs.realpathSync(target), link = fs.readlinkSync(target);
    if (path.isAbsolute(link) || !real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw Error("SHADOW_BUILD");
    return hash(canonical({ symlink: link }));
  }
  if (!info.isFile() || (readonly && (info.mode & 0o222))) throw Error("SHADOW_BUILD");
  return hash(fs.readFileSync(target));
}
function census(root, roots, readonly = false) {
  const result = {};
  function visit(relative) {
    const target = path.join(root, relative), info = fs.lstatSync(target);
    if (info.isDirectory()) {
      if (readonly && (info.mode & 0o222)) throw Error("SHADOW_BUILD");
      for (const name of fs.readdirSync(target).sort()) visit(relative ? `${relative}/${name}` : name);
    } else result[relative] = entryDigest(root, relative, readonly);
  }
  for (const relative of roots) visit(relative);
  return result;
}
function verifyFiles(root, manifest, roots) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Object.keys(manifest).length) throw Error("SHADOW_BUILD");
  for (const [relative, digest] of Object.entries(manifest)) {
    if (!/^[a-f0-9]{64}$/.test(digest) || entryDigest(root, relative, !!roots) !== digest) throw Error("SHADOW_BUILD");
  }
  if (roots && canonical(census(root, roots, true)) !== canonical(manifest)) throw Error("SHADOW_BUILD");
  return hash(canonical(manifest));
}
// The application reads these data files relative to cwd during import. Admit
// regular, bounded exact bytes; do not expose an app-root link or ambient .env.
function runtimeAssets(root, manifest) {
  const assets = {};
  for (const relative of RUNTIME_ASSETS) {
    let fd;
    try {
      fd = fs.openSync(path.join(root, relative), fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const info = fs.fstatSync(fd), maximum = 1024 * 1024;
      if (!info.isFile() || (info.mode & 0o222) || info.size > maximum) throw Error("SHADOW_BUILD");
      const bytes = Buffer.alloc(maximum + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
        if (!count) break;
        used += count;
      }
      if (used > maximum || hash(bytes.subarray(0, used)) !== manifest?.[relative]) throw Error("SHADOW_BUILD");
      assets[relative] = bytes.subarray(0, used);
    } catch { throw Error("SHADOW_BUILD"); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return assets;
}
function projectAssets(directory, assets) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || fs.realpathSync(directory) !== directory ||
      info.uid !== process.getuid() || (info.mode & 0o077) || fs.readdirSync(directory).length ||
      canonical(Object.keys(assets).sort()) !== canonical([...RUNTIME_ASSETS].sort()) ||
      Object.values(assets).some((bytes) => !Buffer.isBuffer(bytes))) throw Error("SHADOW_BUILD");
  for (const relative of RUNTIME_ASSETS) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, assets[relative], { flag: "wx", mode: 0o400 });
  }
}
function admitClosure(profile) {
  const root = fs.realpathSync(profile.app_root);
  if (root !== profile.app_root || (fs.statSync(root).mode & 0o222) || profile.app_entry !== "dist/app.js") throw Error("SHADOW_BUILD");
  const assets = runtimeAssets(root, profile.build_manifest);
  const build = verifyFiles(root, profile.build_manifest, BUILD_ROOTS);
  const dependencies = verifyFiles(root, profile.dependency_manifest, ["node_modules"]);
  if (build !== profile.node_build || dependencies !== profile.node_dependencies || !profile.build_manifest[profile.app_entry]) throw Error("SHADOW_BUILD");
  const admitted = { ...profile.build_manifest, ...profile.dependency_manifest };
  // Root package metadata is admitted before createRequire can inspect it.
  const packageJSON = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  if (packageJSON.type === "module") throw Error("SHADOW_BUILD");
  return { root, build, dependencies, admitted, assets };
}
function fenceModules(root, admitted, forbiddenPaths = new Set()) {
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...args) {
    const resolved = original.call(this, request, parent, ...args);
    if (Module.isBuiltin(resolved)) return resolved;
    const relative = path.relative(root, resolved).split(path.sep).join("/");
    if (forbiddenPaths.has(resolved) || !Object.hasOwn(admitted, relative) ||
        entryDigest(root, relative, true) !== admitted[relative]) throw Error("SHADOW_MODULE");
    if (/\/node_modules\/(?:pg-native|pg)\//.test(resolved) &&
        !resolved.startsWith(path.join(root, "node_modules/pg/") )) throw Error("SHADOW_MODULE");
    return resolved;
  };
  return () => { Module._resolveFilename = original; };
}
function handler(app, requests) {
  const allowedHeaders = new Set(["accept", "accept-encoding", "authorization", "cookie", "if-none-match", "if-modified-since"]);
  const transportHeaders = new Set(["host", "connection", "content-length"]);
  return (req, res) => {
    const headers = {};
    let refused = req.method !== "GET" || !!req.headers["transfer-encoding"] ||
      (req.headers.host !== undefined && req.headers.host !== "localhost") ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");
    const seen = new Set();
    for (let i = 0; i < (req.rawHeaders || []).length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (seen.has(name)) refused = true;
      seen.add(name);
    }
    for (const [name, value] of Object.entries(req.headers)) {
      if (allowedHeaders.has(name)) headers[name] = value;
      else if (!transportHeaders.has(name)) refused = true;
    }
    const request = hash(canonical({ method: "GET", path: req.url, headers }));
    if (refused || !requests.includes(request)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"code":"SHADOW_ROUTE"}');
      return;
    }
    app(req, res);
  };
}
function settingsFor(profile) {
  const settings = profile.settings;
  if (!settings || Array.isArray(settings) || Object.getPrototypeOf(settings) !== Object.prototype ||
      Object.entries(settings).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) ||
      hash(canonical(settings)) !== profile.node_settings) throw Error("SHADOW_SETTINGS");
  for (const name of Object.keys(settings)) {
    if (["MATH_ENV", "DATABASE_URL", "READ_ONLY_DATABASE_URL", "HOME", "PATH", "PWD", "TMPDIR"].includes(name) ||
        (name !== "NODE_ENV" && /^(NODE_|PG|SHADOW_|DOTENV_|LD_|DYLD_)/.test(name))) throw Error("SHADOW_SETTINGS");
  }
  for (const name of ["BACKFILL_COMMENT_LANG_DETECTION", "RUN_PERIODIC_EXPORT_TESTS", "SERVER_LOG_TO_FILE", "SHOULD_USE_TRANSLATION_API"]) {
    if (settings[name] && !["false", "0", "no", "off"].includes(settings[name].toLowerCase())) throw Error("SHADOW_BACKGROUND_WORK");
  }
  return settings;
}
async function main() {
  // Only this control writer may emit output. App logs never enter public
  // stderr/stdout, including uncaught error stacks and configuration failures.
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  const discard = function (_chunk, encoding, callback) {
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  process.stdout.write = discard; process.stderr.write = discard;
  let server, socket, socketIdentity, workdir, Pool, restoreModules, stopping = false;
  const sockets = new Set();
  async function stop(failed) {
    if (stopping) return;
    stopping = true;
    if (failed) stderr("SHADOW_READER_REFUSED\n");
    const forced = setTimeout(() => process.exit(failed ? 2 : 0), 2000);
    try {
      for (const connection of sockets) connection.destroy();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      await Pool?.closeAll();
      if (socketIdentity) {
        const current = fs.lstatSync(socket, { throwIfNoEntry: false });
        if (current && current.ino === socketIdentity.ino && current.dev === socketIdentity.dev) fs.unlinkSync(socket);
      }
      restoreModules?.();
      if (workdir) { process.chdir(os.tmpdir()); fs.rmSync(workdir, { recursive: true, force: true }); }
    } finally { clearTimeout(forced); process.exit(failed ? 2 : 0); }
  }
  process.prependListener("uncaughtException", () => { void stop(true); });
  process.prependListener("unhandledRejection", () => { void stop(true); });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void stop(false); });
  const deadline = setTimeout(() => { void stop(true); }, 30000);
  try {
    if (process.env.SHADOW_READER_ENABLE !== "1" || process.env.NODE_OPTIONS || process.env.NODE_PATH ||
        process.execArgv.some((arg) => !["--no-warnings"].includes(arg))) throw Error("SHADOW_READER_DISABLED");
    const profile = JSON.parse(privateFile(process.env.SHADOW_READER_PROFILE));
    if (profile.schema !== "polis-shadow-reader/1" || !Array.isArray(profile.requests) || !profile.requests.length ||
        profile.requests.length > 10000 || profile.requests.some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(profile.namespace)) throw Error("SHADOW_PROFILE");
    const { root, build, dependencies, admitted, assets } = admitClosure(profile);
    const settings = settingsFor(profile);
    const url = new URL(process.env.SHADOW_READER_DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.password || url.search || url.hash ||
        !url.username || url.pathname.length < 2 || !profile.database_host || url.hostname !== profile.database_host) throw Error("SHADOW_DATABASE");
    const password = privateFile(process.env.SHADOW_READER_PASSWORD_FILE).toString().replace(/\r?\n$/, "");
    const ca = privateFile(process.env.SHADOW_READER_CA_FILE).toString();
    if (!password || password.includes("\0") || !ca.includes("-----BEGIN CERTIFICATE-----")) throw Error("SHADOW_DATABASE");
    socket = path.resolve(profile.socket);
    const parent = fs.lstatSync(path.dirname(socket));
    if (socket !== profile.socket || fs.realpathSync(path.dirname(socket)) !== path.dirname(socket) || fs.existsSync(socket) || !parent.isDirectory() || parent.isSymbolicLink() ||
        parent.uid !== process.getuid() || (parent.mode & 0o077)) throw Error("SHADOW_SOCKET");
    process.umask(0o077);
    workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "polis-shadow-reader-")));
    projectAssets(workdir, assets);
    process.chdir(workdir); // Only admitted data assets; no ambient dotenv file.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, settings, { HOME: workdir, MATH_ENV: profile.namespace,
      DATABASE_URL: url.href, READ_ONLY_DATABASE_URL: url.href });
    restoreModules = fenceModules(root, admitted);
    const requireApp = Module.createRequire(path.join(root, "package.json"));
    const pg = requireApp("pg"), QueryStream = requireApp("pg-query-stream");
    Pool = install(pg, profile.snapshot, { connectionString: url.href, password,
      ssl: { rejectUnauthorized: true, ca } }, { QueryStream });
    pg.Connection = class { constructor() { throw Error("SHADOW_DIRECT_CLIENT"); } };
    // Libraries needed by the pool/stream have loaded before direct PG internals
    // are fenced off from the application import graph.
    restoreModules();
    const denied = new Set(["pg/lib/client", "pg/lib/connection", "pg-pool"].map((p) => requireApp.resolve(p)));
    restoreModules = fenceModules(root, admitted, denied);
    const probe = new Pool();
    const connection = await probe.connect(); connection.release();
    const config = requireApp("./dist/src/config.js").default;
    if (config.backfillCommentLangDetection || config.runPeriodicExportTests || config.logToFile || config.shouldUseTranslationAPI) throw Error("SHADOW_BACKGROUND_WORK");
    const loaded = requireApp("./dist/app.js");
    await loaded.appReady;
    // appReady catches initialization failures; a mounted API route is an
    // additional structural requirement, not a whole-app integration claim.
    if (typeof loaded.default !== "function" || !loaded.default.routes?.get?.some((route) => route.path === "/api/v3/math/pca2")) throw Error("SHADOW_APP");
    await Pool.ready();
    if (stopping) return;
    server = http.createServer(handler(loaded.default, profile.requests));
    server.on("connection", (connection) => { sockets.add(connection); connection.on("close", () => sockets.delete(connection)); });
    server.on("error", () => { void stop(true); });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    fs.chmodSync(socket, 0o600); socketIdentity = fs.lstatSync(socket);
    clearTimeout(deadline);
    stdout(JSON.stringify({ schema: "polis-shadow-reader-ready/1", pid: process.pid,
      namespace: profile.namespace, snapshot: profile.snapshot, node_build: build,
      node_dependencies: dependencies, node_settings: profile.node_settings }) + "\n");
  } catch { clearTimeout(deadline); await stop(true); }
}

module.exports = { BUILD_ROOTS, RUNTIME_ASSETS, projectAssets, canonical, privateFile, entryDigest, census, verifyFiles, admitClosure, fenceModules, settingsFor, handler };
if (require.main === module) void main();
