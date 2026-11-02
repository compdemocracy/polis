import { beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import type { Express } from "express";
import { getApp } from "../app-loader";

describe("Retired API routes", () => {
  let app: Express;
  beforeAll(async () => {
    app = await getApp();
  });

  test.each([
    ["post", "/api/v3/users/invite"],
    ["get", "/api/v3/snapshot"],
    ["get", "/api/v3/dummyButton"],
    ["post", "/api/v3/notifyTeam"],
    ["post", "/api/v3/metrics"],
    ["post", "/api/v3/sendEmailExportReady"],
    ["get", "/api/v3/math/correlationMatrix"],
    ["post", "/api/v3/mathUpdate"],
    ["post", "/api/v3/contributors"],
    ["post", "/api/v3/auth/deregister"],
    ["get", "/api/v3/dataExport"],
    ["get", "/api/v3/dataExport/results"],
    ["get", "/api/v3/math/pca"],
  ] as const)("%s %s returns the generic 404", async (method, path) => {
    const response = await request(app)[method](path);
    expect(response.status).toBe(404);
  });
});
