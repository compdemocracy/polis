import { describe, expect, test, beforeAll } from "@jest/globals";
import request from "supertest";
import type { Response } from "supertest";
import { getApp } from "../app-loader";
import type { Express } from "express";

describe("Simple Supertest Tests", () => {
  let app: Express;

  // Initialize the app before tests run
  beforeAll(async () => {
    app = await getApp();
  });

  test("Health check works", async () => {
    const response: Response = await request(app).get("/api/v3/testConnection");
    expect(response.status).toBe(200);
  });
});
