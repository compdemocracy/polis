/**
 * @jest-environment node
 */
/* eslint-env node */
// The report page loads no code, styles or fonts from a third-party host.
// The browser-global libraries (window.d3, window.Plotly) are copied from
// pinned npm packages into the build, at the exact versions the page has
// always loaded.
const fs = require("node:fs");
const path = require("node:path");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const common = require("./webpack.common");

// Deliberate third parties, kept until the project rules on them.
const DELIBERATE_HOSTS = ["scripts.simpleanalyticscdn.com", "queue.simpleanalyticscdn.com"];

const template = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const copyPlugin = common.plugins.find((p) => p instanceof CopyWebpackPlugin);
const htmlPlugin = common.plugins.find((p) => p instanceof HtmlWebpackPlugin);

test("index.html loads nothing from a third-party host except the deliberate ones", () => {
  const urls = Array.from(template.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g), (m) => m[1]);
  expect(urls).toContain("/favicon.ico");
  const hosts = urls
    .filter((u) => /^(https?:)?\/\//.test(u))
    .map((u) => new URL(u, "https://example.invalid").hostname);
  expect(hosts.filter((h) => !DELIBERATE_HOSTS.includes(h))).toEqual([]);
});

test("window.d3 and window.Plotly come from this build at the versions always served", () => {
  const scripts = htmlPlugin.userOptions.vendorScripts;
  expect(scripts).toEqual([
    "/report_vendor_d3-4.13.0.min.js",
    "/report_vendor_d3-scale-chromatic-1.5.0.min.js",
    "/report_vendor_plotly-2.27.0.min.js",
  ]);
  for (const src of scripts) {
    const pattern = copyPlugin.patterns.find((p) => `/${p.to}` === src);
    expect(pattern).toBeDefined();
    expect(fs.existsSync(pattern.from)).toBe(true);
    // Copied byte for byte: the production minifier must leave them alone.
    expect(pattern.info).toEqual({ minimized: true });
  }
  expect(template).toContain("htmlWebpackPlugin.options.vendorScripts");
});
