import { beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import type { Express } from "express";
import { getApp } from "../app-loader";

// Page requests reach the static file server through the remaining proxy.
// Include the demo filenames too: removing their aliases must not leave the
// same pages available as static HTML.
const paths = [
  "/share/2retired",
  "/summary/2retired",
  "/explore/2retired",
  "/ot/2retired/invite",
  "/iip/2retired",
  "/iim/2retired",
  "/embed",
  "/embed.html",
  "/embedPreprod",
  "/embedPreprod.html",
  "/embedReport",
  "/embedReport.html",
  "/embedReportPreprod",
  "/embedReportPreprod.html",
  "/styleguide",
  "/dist/admin_bundle.js",
  "/__webpack_hmr",
  "/cached/retired.js",
  "/font/retired.woff",
  "/legacy-embed.js/retired",
  "/missing-static-file.html",
];

describe("retired pages and bundles", () => {
  let app: Express;
  beforeAll(async () => {
    app = await getApp();
  });

  test.each(paths)("GET %s answers 404", async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
