// The participation page loads no code from a third-party host except the
// deliberate analytics: window.jwt_decode comes from this build.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const template = fs.readFileSync(path.join(root, "public/index.ejs"), "utf8");

// Deliberate third parties, kept until the project rules on them. Google
// Analytics is only present when the build sets GA_TRACKING_ID.
const DELIBERATE_HOSTS = ["www.googletagmanager.com", "scripts.simpleanalyticscdn.com", "queue.simpleanalyticscdn.com"];

test("index.ejs loads nothing from a third-party host except the deliberate ones", () => {
  const urls = [...template.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const hosts = urls
    .filter((u) => /^(https?:)?\/\//.test(u))
    .map((u) => new URL(u, "https://example.invalid").hostname);
  assert.ok(hosts.includes("scripts.simpleanalyticscdn.com"), "the scan sees the page's script tags");
  assert.deepEqual(
    hosts.filter((h) => !DELIBERATE_HOSTS.includes(h)),
    []
  );
});

test("jwt_decode is the pinned 3.1.2 browser build, copied into this build", () => {
  assert.match(template, /<script src="<%= jwtDecodeSrc %>"><\/script>/);
  const pkg = require(path.join(root, "node_modules/jwt-decode/package.json"));
  assert.equal(pkg.version, "3.1.2");
  const browserBuild = fs.readFileSync(path.join(root, "node_modules/jwt-decode/build/jwt-decode.js"), "utf8");
  assert.match(browserBuild, /window\.jwt_decode = jwtDecode/);
});
