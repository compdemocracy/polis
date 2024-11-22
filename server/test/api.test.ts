import request from "supertest";
import app from "../app";

describe("API", () => {
  describe("GET /api/v3/testConnection", () => {
    it("should return 200 OK", () => {
      return request(app).get("/api/v3/testConnection").expect(200);
    });
  });

  describe("GET /api/v3/testDatabase", () => {
    it("should return 200 OK", () => {
      return request(app).get("/api/v3/testDatabase").expect(200);
    });
  });
});
