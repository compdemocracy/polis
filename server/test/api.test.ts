import request from "supertest";
import app from "../app";

describe("GET /api/v3/testConnection", () => {
  it("should return 200 OK", () => {
    return request(app).get("/api/v3/testConnection")
      .expect(200);
  });
});