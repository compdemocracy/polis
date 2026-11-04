import express from "express";
import request from "supertest";
import http from "node:http";
import { EventEmitter } from "node:events";
import Ajv from "ajv";
import { fields, signature } from "../../src/utils/clientErrorReporter";
import { ClientError } from "../../src/contracts/clientError";
import { clientValidate } from "./contracts/contractHelpers";
import { createClientErrorHandler } from "../../src/routes/clientErrors";

// Serial cases keep separate apps and rate-limit state on one loopback listener.
let currentApp: express.Express;
let baseUrl: string;
let port: number;
const agent = new http.Agent({ keepAlive: true });
const server = http.createServer((req, res) => currentApp(req, res));

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  port = (server.address() as import("node:net").AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  agent.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function postTo(app: express.Express, path = "/api/v3/clientErrors") {
  currentApp = app;
  return request(baseUrl).post(path).agent(agent);
}

const payload = {
  client: "alpha",
  build: "a".repeat(40),
  page: "/alpha/example?token=private",
  kind: "error",
  message: "TypeError: Cannot read properties of undefined (reading 'text')",
  stack:
    "TypeError: private conversation\n at render (https://example.test/_astro/app.abcd.js?token=private:12:7)",
  resource: "/api/v3/math/pca2?conversation_id=private",
};
function fixture() {
  const logs: any[] = [];
  let time = 0;
  const app = express();
  const router = express();
  router.set("trust proxy", 1);
  router.post(
    "/api/v3/clientErrors",
    createClientErrorHandler(
      (x) => logs.push(x),
      () => time
    )
  );
  app.use(router);
  app.use(express.json({ limit: "50mb" }));
  app.post("/other", (_req, res) => res.send(201));
  return {
    app,
    logs,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
async function post(
  f: ReturnType<typeof fixture>,
  body: any = payload,
  ip = "192.0.2.1"
) {
  f.app.set("trust proxy", 1);
  return postTo(f.app)
    .set("X-Forwarded-For", `${ip}, 173.245.48.1`)
    .set("User-Agent", "Mozilla/5.0 private@example.test Chrome/120.0.0.0")
    .set("Cookie", "private-cookie")
    .set("Authorization", "Bearer private-token")
    .set("Content-Type", "text/plain")
    .send(typeof body === "string" ? body : JSON.stringify(body));
}
test("one bounded structured record, no identity, query, origin, content or IP", async () => {
  const f = fixture();
  expect(
    (
      await post(f, {
        ...payload,
        email: "private@example.test",
        text: "conversation content",
      })
    ).status
  ).toBe(204);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toEqual({
    message: "client_error",
    client: "alpha",
    build: "a".repeat(40),
    page: "/alpha/:id",
    kind: "error",
    error_message: "TypeError: Cannot read properties of undefined",
    stack: "/_astro/app.abcd.js:12:7",
    resource: "/api/v3/math/pca2",
    user_agent: "Mozilla/5.0 Chrome/120.0.0.0",
    method: "",
    status: 0,
    duration_ms: 0,
    signature: signature(fields(payload)),
    count: 1,
  });
  expect(JSON.stringify(f.logs)).not.toMatch(
    /private|conversation content|192\.0\.2|Cookie|Authorization/
  );
});
test("JSON content type also accepted", async () => {
  const f = fixture();
  expect(
    (await postTo(f.app).send(payload)).status
  ).toBe(204);
  expect(f.logs).toHaveLength(1);
});
test.each(["{", "null", "[]", "42", '"private"', "", '{"client":"unknown"}'])(
  "garbage %s is quietly 204",
  async (body) => {
    const f = fixture();
    expect((await post(f, body)).status).toBe(204);
    expect(f.logs).toHaveLength(0);
  }
);
test("declared and chunked bodies over 4096 bytes are quietly refused", async () => {
  const f = fixture();
  expect((await post(f, "x".repeat(4097))).status).toBe(204);
  currentApp = f.app;
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        agent,
        method: "POST",
        path: "/api/v3/clientErrors",
        headers: {
          "Content-Type": "text/plain",
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.write("x".repeat(2048));
    req.end("x".repeat(2049));
  });
  expect(status).toBe(204);
  expect(f.logs).toHaveLength(0);
});
test("compressed bodies are refused without decompression", async () => {
  const f = fixture();
  expect(
    (
      await postTo(f.app)
        .set("Content-Encoding", "gzip")
        .send(payload)
    ).status
  ).toBe(204);
  expect(f.logs).toHaveLength(0);
});
test("all fields are projected and bounded even for a direct caller", async () => {
  const f = fixture();
  expect(
    (
      await post(f, {
        ...payload,
        message: "private prose",
        build: "private@example.test",
        page: "/someone@example.test",
        resource: "/private/name",
        stack: "private prose",
      })
    ).status
  ).toBe(204);
  expect(f.logs[0]).toMatchObject({
    error_message: "Error",
    build: "unknown",
    page: "/:id",
    resource: "/:id/:id",
    stack: "",
  });
});
test("per-IP flood: ten accepted, refill after a minute, independent IP", async () => {
  const f = fixture();
  for (let i = 0; i < 150; i++) expect((await post(f)).status).toBe(204);
  expect(f.logs).toHaveLength(10);
  expect((await post(f, payload, "192.0.2.2")).status).toBe(204);
  expect(f.logs).toHaveLength(11);
  f.advance(60000);
  await post(f);
  expect(f.logs).toHaveLength(12);
});
test("global budget bounds many-IP floods", async () => {
  const f = fixture();
  for (let i = 0; i < 120; i++)
    expect(
      (await post(f, { ...payload, count: 1e100 }, `192.0.2.${i}`)).status
    ).toBe(204);
  expect(f.logs).toHaveLength(100);
  expect(f.logs.reduce((sum, record) => sum + record.count, 0)).toBe(100000);
});
test("logging failure still responds 204", async () => {
  const app = express();
  app.post(
    "/api/v3/clientErrors",
    createClientErrorHandler(() => {
      throw Error("unavailable");
    })
  );
  expect(
    (await postTo(app).send(payload)).status
  ).toBe(204);
});

const kinds = [
  "error",
  "unhandledrejection",
  "console_error",
  "console_warn",
  "fetch",
  "xhr",
  "resource",
  "csp",
];
const validate = new Ajv().compile(ClientError);
test.each(kinds)(
  "%s logs the shared contract with a recomputed signature",
  async (kind) => {
    const f = fixture();
    const value = {
      ...payload,
      kind,
      method: "POST",
      status: 503,
      duration_ms: 120,
      count: 7,
      signature: "0123456789abcdef",
    };
    expect((await post(f, value)).status).toBe(204);
    expect(f.logs).toHaveLength(1);
    const { error_message, user_agent: _ua, ...logged } = f.logs[0];
    const projected = { ...logged, message: error_message };
    expect(validate(projected)).toBe(true);
    expect(projected).toEqual(fields(value));
    expect(projected.signature).toBe(signature(projected));
    expect(projected.signature).not.toBe(value.signature);
    expect(projected.count).toBe(7);
    if (kind !== "fetch" && kind !== "xhr") {
      expect(projected).toMatchObject({
        method: "",
        status: 0,
        duration_ms: 0,
      });
    }
  }
);
test.each([0, -1, 1001, 1e100, 1.5, "100", null, {}, []])(
  "count %j remains bounded in one log operation",
  async (count) => {
    const f = fixture();
    await post(f, { ...payload, count });
    expect(f.logs).toHaveLength(1);
    expect(Number.isInteger(f.logs[0].count)).toBe(true);
    expect(f.logs[0].count).toBeGreaterThanOrEqual(1);
    expect(f.logs[0].count).toBeLessThanOrEqual(1000);
  }
);
test("network metadata is bounded and arbitrary caller fields never reach the logger", async () => {
  const f = fixture();
  await post(f, {
    ...payload,
    kind: "xhr",
    method: "private text",
    status: 900,
    duration_ms: 1e100,
    signature: "private signature",
    count: 1000,
    body: "private body",
    headers: { cookie: "private cookie" },
    request: { url: "private address" },
    response: "private response",
  });
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0].method).toBe("");
  expect(f.logs[0].status).toBe(0);
  expect(f.logs[0].duration_ms).toBeLessThanOrEqual(60000);
  expect(JSON.stringify(f.logs)).not.toMatch(/private/);
  expect(Object.keys(f.logs[0]).sort()).toEqual(
    [
      "message",
      "client",
      "build",
      "page",
      "kind",
      "error_message",
      "stack",
      "resource",
      "method",
      "status",
      "duration_ms",
      "signature",
      "count",
      "user_agent",
    ].sort()
  );
});
test("projected stack and signature survive browser-to-server reprojection", async () => {
  const f = fixture();
  const projected = fields(payload);
  await post(f, projected);
  expect(f.logs[0].stack).toBe(projected.stack);
  expect(f.logs[0].signature).toBe(projected.signature);
});
test("contract rejects absent or additional keys and excessive counts", () => {
  const value = fields(payload);
  expect(validate(value)).toBe(true);
  for (const key of Object.keys(value)) {
    const copy = { ...value };
    delete copy[key];
    expect(validate(copy)).toBe(false);
  }
  for (const changed of [
    { count: 1001 },
    { signature: "abc" },
    { text: "private" },
    { duration_ms: 60001 },
  ]) {
    expect(validate({ ...value, ...changed })).toBe(false);
  }
});
function streamRequest(
  handler: ReturnType<typeof createClientErrorHandler>,
  ip = "192.0.2.1"
) {
  const req: any = new EventEmitter();
  req.ip = ip;
  req.socket = {};
  req.headers = { "content-type": "text/plain" };
  req.resume = jest.fn();
  const res: any = new EventEmitter();
  res.setHeader = jest.fn();
  res.end = jest.fn(() => {
    res.writableEnded = true;
  });
  handler(req, res);
  return { req, res };
}
test("32 slow bodies release all permits after five seconds", () => {
  jest.useFakeTimers();
  try {
    const logs: unknown[] = [];
    const handler = createClientErrorHandler((value) => logs.push(value));
    const parked = Array.from({ length: 32 }, (_, i) =>
      streamRequest(handler, `192.0.2.${i}`)
    );
    expect(parked.every(({ res }) => !res.writableEnded)).toBe(true);
    expect(streamRequest(handler, "198.51.100.1").res.statusCode).toBe(204);
    jest.advanceTimersByTime(5000);
    for (const { req, res } of parked) {
      expect(res.statusCode).toBe(204);
      expect(req.listenerCount("data")).toBe(0);
    }
    const next = streamRequest(handler, "198.51.100.2");
    expect(next.res.writableEnded).not.toBe(true);
    next.req.emit("aborted");
    expect(logs).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
test("aborted and closed requests release their active permit only once", () => {
  const logs: unknown[] = [];
  const handler = createClientErrorHandler((value) => logs.push(value));
  for (let i = 0; i < 32; i++) {
    const { req, res } = streamRequest(handler, `192.0.2.${i}`);
    req.emit("aborted");
    res.emit("close");
    req.emit("error", Error("closed"));
  }
  const parked = Array.from({ length: 32 }, (_, i) =>
    streamRequest(handler, `198.51.100.${i}`)
  );
  expect(parked.every(({ res }) => !res.writableEnded)).toBe(true);
  expect(streamRequest(handler, "203.0.113.1").res.statusCode).toBe(204);
  for (const { req } of parked) req.emit("aborted");
  expect(logs).toHaveLength(0);
});
test("a reporter flood does not consume the unrelated route's request budget", async () => {
  const f = fixture();
  for (let i = 0; i < 120; i++) await post(f, payload, `192.0.2.${i}`);
  expect((await postTo(f.app, "/other").send({})).status).toBe(201);
  f.advance(1000);
  await post(f, payload, "198.51.100.1");
  expect(f.logs).toHaveLength(101);
});
test("an expired IP entry is replaced when the map reaches capacity", () => {
  let time = 0;
  const logs: unknown[] = [];
  const handler = createClientErrorHandler(
    (value) => logs.push(value),
    () => time
  );
  for (let i = 0; i < 4096; i++) {
    time += 1000;
    const { req } = streamRequest(handler, `test-ip-${i}`);
    req.emit("data", Buffer.from(JSON.stringify(payload)));
    req.emit("end");
  }
  expect(logs).toHaveLength(4096);
  time = 4096000;
  const before = logs.length;
  const next = streamRequest(handler, "new-ip");
  next.req.emit("data", Buffer.from(JSON.stringify(payload)));
  next.req.emit("end");
  expect(logs).toHaveLength(before + 1);
});

test("both contract validators enforce string limits including Unicode", () => {
  for (const [key, max] of [
    ["page", 160],
    ["resource", 160],
    ["message", 256],
    ["stack", 1024],
  ] as const) {
    for (const length of [max, max + 1]) {
      const value = { ...fields(payload), [key]: "😀".repeat(length) };
      expect(validate(value)).toBe(length === max);
      expect(clientValidate(ClientError, value, false).valid).toBe(
        length === max
      );
    }
  }
});

test("only JSON and plain text content types reach the logger", async () => {
  const f = fixture();
  for (const type of [
    "text/html",
    "application/octet-stream",
    "application/jsonp",
  ]) {
    expect(
      (
        await postTo(f.app)
          .set("Content-Type", type)
          .send(JSON.stringify(payload))
      ).status
    ).toBe(204);
  }
  expect(f.logs).toHaveLength(0);
});
test("signature grouping ignores build, page, method, lower frames, count and duration", () => {
  const value = fields({
    ...payload,
    stack: "/_astro/app.js:1:2\n/_astro/other.js:3:4",
  });
  expect(
    signature({
      ...value,
      build: "b".repeat(40),
      page: "/other",
      method: "POST",
      stack: "/_astro/app.js:1:2\n/_astro/else.js:5:6",
      count: 1000,
      duration_ms: 60000,
    })
  ).toBe(value.signature);
});

test("production logger binding emits the exact queryable event name", async () => {
  const { createLogger, format, transports } = require("winston");
  const { Writable } = require("node:stream");
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: string, done: () => void) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = createLogger({
    format: format.json(),
    transports: [new transports.Stream({ stream })],
  });
  const source = require("node:fs").readFileSync(
    require("node:path").resolve(__dirname, "../../app.ts"),
    "utf8"
  );
  const binding = source.match(
    /const handleClientError = createClientErrorHandler\([\s\S]*?\n\);/
  )[0];
  const handler = new Function(
    "createClientErrorHandler",
    "logger",
    binding + "\nreturn handleClientError;"
  )(createClientErrorHandler, logger);
  const app = express();
  app.post("/api/v3/clientErrors", handler);
  await postTo(app).send(payload).expect(204);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({
    message: "client_error",
    client: "alpha",
    count: 1,
  });
  logger.close();
});

test("31 participants behind one Cloudflare hop have independent budgets", async () => {
  const f = fixture();
  for (let i = 1; i <= 31; i++) await post(f, payload, `192.0.2.${i}`);
  expect(f.logs).toHaveLength(31);
  expect(JSON.stringify(f.logs)).not.toMatch(/192\.0\.2|173\.245/);
});

test("refused address traffic leaves shared refill for other participants", async () => {
  const f = fixture();
  for (let i = 0; i < 150; i++) await post(f);
  for (let i = 1; i <= 60; i++) {
    f.advance(1000);
    await post(f);
    await post(f);
    await post(f, payload, `198.51.100.${i}`);
  }
  expect(f.logs.filter((x) => x.client === "alpha")).toHaveLength(71);
});

test("client-supplied earlier hops cannot rotate the participant bucket", async () => {
  const f = fixture();
  for (let i = 1; i <= 20; i++)
    await post(f, payload, `198.51.100.${i}, 192.0.2.1`);
  expect(f.logs).toHaveLength(10);
});

test("an unrecognized final hop does not authorize the earlier address", async () => {
  const f = fixture();
  for (let i = 1; i <= 20; i++)
    await postTo(f.app)
      .set("X-Forwarded-For", `192.0.2.${i}, 203.0.113.1`)
      .send(payload);
  expect(f.logs).toHaveLength(10);
});

test("equivalent IPv6 client spellings share the address limit", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) await post(f, payload, "2001:db8::1");
  await post(f, payload, "2001:0db8:0:0:0:0:0:1");
  expect(f.logs).toHaveLength(10);
  await post(f, payload, "2001:db8::2");
  expect(f.logs).toHaveLength(10);
  await post(f, payload, "2001:db8:0:1::1");
  expect(f.logs).toHaveLength(11);
});

test("client error proxy ranges match production ingress configuration", () => {
  const {
    clientErrorProxyRanges,
  } = require("../../src/utils/clientErrorAddress");
  const { cidrs } = require("../../../cdk/config/cloudflare-ips-v4.json");
  expect(clientErrorProxyRanges).toEqual(cidrs);
});

test.each(["not-an-address", "", "x".repeat(2049)])(
  "malformed forwarded clients retain the proxy budget: %s",
  async (participant) => {
    const f = fixture();
    for (let i = 0; i < 11; i++) await post(f, payload, participant);
    expect(f.logs).toHaveLength(10);
  }
);

test("IPv4 and its mapped IPv6 form share the participant budget", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) await post(f, payload, "192.0.2.1");
  await post(f, payload, "::ffff:192.0.2.1");
  expect(f.logs).toHaveLength(10);
});

test("a scoped IPv6 address cannot throw during address projection", async () => {
  const f = fixture();
  expect((await post(f, payload, "fe80::1%eth0")).status).toBe(204);
  expect(f.logs).toHaveLength(1);
});


test("rotating IPv6 interface addresses cannot fill the address map", async () => {
  const f = fixture();
  for (let i = 0; i < 4096; i++)
    await post(f, payload, `2001:db8:1234:5678::${i.toString(16)}`);
  expect(f.logs).toHaveLength(10);
  await post(f, payload, "2001:db8:1234:5679::1");
  expect(f.logs).toHaveLength(11);
}, 30000);

test("process refusal preserves the participant's entire burst", async () => {
  const f = fixture();
  for (let i = 1; i <= 100; i++) await post(f, payload, `192.0.2.${i}`);
  for (let i = 0; i < 10; i++) await post(f, payload, "198.51.100.1");
  expect(f.logs).toHaveLength(100);
  f.advance(10000);
  for (let i = 0; i < 11; i++) await post(f, payload, "198.51.100.1");
  expect(f.logs).toHaveLength(110);
});

test("server logs distinct positions from one content-hashed bundle", async () => {
  const f = fixture();
  for (const position of ["2:631474", "2:98765", "1:200"])
    await post(f, { ...payload, stack: `/js/participation_bundle.12345678.js:${position}` });
  expect(f.logs).toHaveLength(3);
  expect(new Set(f.logs.map((x) => x.signature)).size).toBe(3);
  expect(f.logs.map((x) => x.stack)).toEqual(
    ["2:631474", "2:98765", "1:200"].map((p) => `/js/participation_bundle.12345678.js:${p}`)
  );
});


test.each([
  ["2001:db8::1", "2001:db8:0:0::/64"],
  ["2001:0db8:0000:0000:abcd:12:34:56", "2001:db8:0:0::/64"],
  ["2001:db8:0:1::1", "2001:db8:0:1::/64"],
  ["::1", "0:0:0:0::/64"],
  ["fe80::1%eth0", "fe80:0:0:0::/64"],
  ["fe80::2%eth1", "fe80:0:0:0::/64"],
  ["::ffff:192.0.2.1", "192.0.2.1"],
])("address prefix projection: %s", (participant, expected) => {
  const { clientErrorAddress } = require("../../src/utils/clientErrorAddress");
  expect(clientErrorAddress({
    ip: "173.245.48.1",
    headers: { "x-forwarded-for": `${participant}, 173.245.48.1` },
  })).toBe(expected);
  expect(clientErrorAddress({ ip: participant, headers: {} })).toBe(expected);
});
