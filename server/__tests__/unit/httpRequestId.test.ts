/**
 * The production access line (`http_request`) carries `request_id` when the
 * request carries nginx's X-Request-Id (32 lowercase hex): nginx sets it on a
 * vote it also copies to the read-only shadow service, so every Node outcome
 * for that vote, middleware refusals included, can be joined with the copy.
 * Any other value is not logged, and a line without the header is exactly the
 * line it was before. The line's level still follows its status.
 */
import { describe, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { httpLogLevel, requestIdOf } from "../../src/server-middleware";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";

type Logged = { level: unknown; message: unknown; meta: unknown };

// One request through middleware_http_json_logger outside dev mode (the
// access line is written only there), with the logger replaced.
function accessLine(
  headers: Record<string, unknown>,
  statusCode = 200
): Logged[] {
  const previousDevMode = process.env.DEV_MODE;
  const logged: Logged[] = [];
  try {
    jest.isolateModules(() => {
      process.env.DEV_MODE = "false";
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const logger = require("../../src/utils/logger").default;
      jest
        .spyOn(logger, "log")
        .mockImplementation(
          (level: unknown, message: unknown, meta: unknown) => {
            logged.push({ level, message, meta });
            return logger;
          }
        );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        middleware_http_json_logger,
      } = require("../../src/server-middleware");
      const req = {
        method: "POST",
        originalUrl: "/api/v3/votes",
        ip: "203.0.113.5",
        headers: { "user-agent": "jest", ...headers },
      };
      const res = Object.assign(new EventEmitter(), { statusCode });
      const next = jest.fn();
      middleware_http_json_logger(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      res.emit("finish");
    });
  } finally {
    if (previousDevMode === undefined) {
      delete process.env.DEV_MODE;
    } else {
      process.env.DEV_MODE = previousDevMode;
    }
  }
  return logged;
}

function withoutDuration(meta: unknown) {
  const { duration_ms, ...rest } = meta as Record<string, unknown>;
  expect(typeof duration_ms).toBe("number");
  return rest;
}

describe("http_request request_id", () => {
  test("a well-formed X-Request-Id is logged as request_id, and nothing else changes", () => {
    const [withId] = accessLine({ "x-request-id": REQUEST_ID });
    const [without] = accessLine({});
    expect(withId.message).toBe("http_request");
    expect(withId.level).toBe("info");
    const meta = withoutDuration(withId.meta);
    expect(meta.request_id).toBe(REQUEST_ID);
    const { request_id, ...rest } = meta;
    expect(request_id).toBe(REQUEST_ID);
    expect(rest).toEqual(withoutDuration(without.meta));
    expect(Object.keys(withId.meta as object)).toEqual([
      "message",
      "service",
      "env",
      "http",
      "network",
      "useragent",
      "duration_ms",
      "request_id",
    ]);
  });

  test.each([
    ["no header", {}],
    ["an empty header", { "x-request-id": "" }],
    ["upper-case hex", { "x-request-id": REQUEST_ID.toUpperCase() }],
    ["31 characters", { "x-request-id": REQUEST_ID.slice(1) }],
    ["33 characters", { "x-request-id": REQUEST_ID + "0" }],
    ["not hex", { "x-request-id": "z".repeat(32) }],
    ["a line break", { "x-request-id": REQUEST_ID + "\n" }],
    ["a repeated header", { "x-request-id": [REQUEST_ID, REQUEST_ID] }],
  ])("%s: no request_id key", (_name, headers) => {
    const [line] = accessLine(headers);
    expect(line.meta).not.toHaveProperty("request_id");
    expect(JSON.stringify(line.meta)).not.toContain(REQUEST_ID);
  });

  test.each([
    [200, "info"],
    [302, "info"],
    [403, "warn"],
    [406, "warn"],
    [500, "error"],
    [502, "error"],
  ])("status %s keeps level %s, with the request id", (status, level) => {
    const [line] = accessLine({ "x-request-id": REQUEST_ID }, status);
    expect(line.level).toBe(level);
    expect((line.meta as { request_id?: string }).request_id).toBe(REQUEST_ID);
    expect(httpLogLevel(status)).toBe(level);
  });

  test("requestIdOf reads only a single 32-hex value", () => {
    expect(requestIdOf({ headers: { "x-request-id": REQUEST_ID } })).toBe(
      REQUEST_ID
    );
    expect(requestIdOf({ headers: {} })).toBeUndefined();
    expect(requestIdOf({})).toBeUndefined();
    expect(
      requestIdOf({ headers: { "x-request-id": ` ${REQUEST_ID}` } })
    ).toBeUndefined();
    expect(
      requestIdOf({ headers: { "X-Request-Id": REQUEST_ID } })
    ).toBeUndefined();
  });
});
