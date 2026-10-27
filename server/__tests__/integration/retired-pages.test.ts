import { beforeAll, expect, test } from "@jest/globals";
import request from "supertest";
import type { Express } from "express";
import { getApp } from "../app-loader";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

// Pages reach the normal static-file proxy; the tutorial POST reaches Express's
// generic 404. Exercise nested paths too, since the old shells used prefixes.
const pages = [
  "/about",
  "/createuser",
  "/gov",
  "/company",
  "/contrib",
  "/demo",
  "/demo/2demo",
  "/bot",
  "/bot/install",
  "/bot/support",
  "/pwresetinit",
  "/pwreset",
  "/other-conversations",
  "/user/create",
  "/user/login",
  "/user/logout",
  "/settings",
  "/conversation/create",
  "/inbox",
  "/inboxApiTest",
  "/hk",
  "/hk/new",
  "/s/legacy",
  "/s",
  "/s/CTE",
  "/football",
  "/pdf",
  "/nabi",
  "/createuser/step",
  "/gov/legacy",
  "/contrib/legacy",
  "/bot/legacy",
  "/bot/install/legacy",
  "/bot/support/legacy",
  "/pwresetinit/legacy",
  "/pwreset/legacy",
  "/other-conversations/legacy",
  "/user/create/step",
  "/user/login/step",
  "/user/logout/step",
  "/settings/step",
  "/conversation/create/step",
  "/inbox/legacy",
  "/inboxApiTest/legacy",
  "/hk/legacy",
];

test("retired tutorial, onboarding and marketing routes answer 404", async () => {
  const routes = [
    { method: "post" as const, path: "/api/v3/tutorial" },
    ...pages.map((path) => ({ method: "get" as const, path })),
  ];
  for (const { method, path } of routes) {
    const response = await request(app)[method](path);
    expect({ method, path, status: response.status }).toEqual({
      method,
      path,
      status: 404,
    });
    if (method === "post") {
      expect(response.text).toBe(`Cannot POST ${path}\n`);
    }
  }
});
