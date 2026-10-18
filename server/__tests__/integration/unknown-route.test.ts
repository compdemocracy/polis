import { describe, expect, test, beforeAll } from "@jest/globals";
import request from "supertest";
import type { Express } from "express";
import { getApp } from "../app-loader";

// Requests shaped like the sweeps scanners send against Next.js apps: a POST
// of a multipart/form-data server-action body, with a Next-Action header, to a
// path no route here serves. The shared body parser used to include connect's
// multipart parser, whose multiparty version calls os.tmpDir() (removed from
// Node) while constructing its form, so every multipart request threw before
// routing and answered 500, whatever its path.
const BOUNDARY = "----WebKitFormBoundaryx8jO2oVc6SWP3Sad";
const MULTIPART_BODY = [
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="0"',
  "",
  '{"then":"$1:__proto__:then","status":"resolved_model","reason":-1,' +
    '"value":"{\\"then\\":\\"$B1337\\"}","_response":{"_prefix":"x",' +
    '"_chunks":"$Q2","_formData":{"get":"$1:constructor:constructor"}}}',
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="1"',
  "",
  '"$@0"',
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="2"',
  "",
  "[]",
  `--${BOUNDARY}--`,
  "",
].join("\r\n");

const SCANNED_PATHS = [
  "/",
  "/_next",
  "/_next/server",
  "/api",
  "/api/route",
  "/api/auth",
  "/admin",
  "/login",
  "/app",
  "/actions",
  "/dashboard",
  "/settings",
];

describe("requests to a path no route serves", () => {
  let app: Express;

  beforeAll(async () => {
    app = await getApp();
  });

  test.each(SCANNED_PATHS)(
    "a scanner's multipart POST to %s answers 404",
    async (path) => {
      const res = await request(app)
        .post(path)
        .set("Content-Type", `multipart/form-data; boundary=${BOUNDARY}`)
        .set("Next-Action", "x")
        .send(MULTIPART_BODY);

      expect(res.status).toBe(404);
      expect(res.text).toBe(`Cannot POST ${path}\n`);
    }
  );

  test.each(["put", "patch", "delete"] as const)(
    "a multipart %s to /admin answers 404",
    async (method) => {
      const client = request(app);
      const res = await client[method]("/admin")
        .set("Content-Type", `multipart/form-data; boundary=${BOUNDARY}`)
        .send(MULTIPART_BODY);

      expect(res.status).toBe(404);
      expect(res.text).toBe(`Cannot ${method.toUpperCase()} /admin\n`);
    }
  );

  test.each(["/", "/admin"])(
    "a JSON POST to %s with the same keys in the query and the body answers 404",
    async (path) => {
      const res = await request(app)
        .post(`${path}?conversation_id=2scan&xid=query`)
        .set("Content-Type", "application/json")
        .send({ conversation_id: "2scan", xid: "body" });

      expect(res.status).toBe(404);
      expect(res.text.startsWith(`Cannot POST ${path}?conversation_id=`)).toBe(
        true
      );
    }
  );
});

describe("a known route given a multipart body", () => {
  let app: Express;

  beforeAll(async () => {
    app = await getApp();
  });

  test("answers the route's own missing-parameter 400, not 500", async () => {
    const res = await request(app)
      .post("/api/v3/metrics")
      .set("Content-Type", `multipart/form-data; boundary=${BOUNDARY}`)
      .send(MULTIPART_BODY);

    expect(res.status).toBe(400);
  });

  test("still answers a JSON body as before", async () => {
    const res = await request(app)
      .post("/api/v3/metrics")
      .send({ types: [1], times: [2], durs: [3], clientTimestamp: 4 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
