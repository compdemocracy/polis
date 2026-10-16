/**
 * The production access log (`middleware_http_json_logger`) records every
 * request's URL next to the client IP and user agent. Query parameters that
 * identify or authenticate a person (the participant xid and its metadata,
 * e-mail addresses, tokens, invite and login codes, signatures) are replaced
 * before the line is written; the path, every other parameter, the status
 * and the timing are logged as before.
 */
import { describe, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { redactUrlForLog } from "../../src/server-middleware";

describe("redactUrlForLog", () => {
  test.each([
    [
      "/api/v3/participationInit?conversation_id=2abc&xid=person-42&pid=-1&lang=en",
      "/api/v3/participationInit?conversation_id=2abc&xid=[redacted]&pid=-1&lang=en",
    ],
    [
      "/2abc?xid=person-42&x_name=Ann&x_email=ann%40example.com&x_profile_image_url=https%3A%2F%2Fexample.com%2Fa.png",
      "/2abc?xid=[redacted]&x_name=[redacted]&x_email=[redacted]&x_profile_image_url=[redacted]",
    ],
    [
      "/api/v3/notifications/subscribe?conversation_id=2abc&email=ann%40example.com&signature=0123abcd",
      "/api/v3/notifications/subscribe?conversation_id=2abc&email=[redacted]&signature=[redacted]",
    ],
    [
      "/api/v3/participationInit?conversation_id=2abc&suzinvite=one-time-code",
      "/api/v3/participationInit?conversation_id=2abc&suzinvite=[redacted]",
    ],
    ["/api/v3/einvites?einvite=abc123", "/api/v3/einvites?einvite=[redacted]"],
    [
      "/api/v3/treevite/login?login_code=123456&conversation_id=2abc",
      "/api/v3/treevite/login?login_code=[redacted]&conversation_id=2abc",
    ],
    [
      "/api/v3/treevite/invite?invite_code=abc-def",
      "/api/v3/treevite/invite?invite_code=[redacted]",
    ],
    ["/signin?code=oidc-code&state=xyz", "/signin?code=[redacted]&state=xyz"],
    ["/2abc?token=t&password=p", "/2abc?token=[redacted]&password=[redacted]"],
    // Parameter names are matched whole and without regard to case.
    [
      "/2abc?xid_required=true&use_xid_whitelist=false&XID=person-42",
      "/2abc?xid_required=true&use_xid_whitelist=false&XID=[redacted]",
    ],
    ["/2abc?xid=person-42#about", "/2abc?xid=[redacted]#about"],
    ["/2abc?xid=&lang=en", "/2abc?xid=[redacted]&lang=en"],
    // Nothing to redact: the URL is unchanged.
    [
      "/api/v3/xid/00000000-0000-4000-8000-000000000000-xid.csv",
      "/api/v3/xid/00000000-0000-4000-8000-000000000000-xid.csv",
    ],
    [
      "/api/v3/votes?conversation_id=2abc&tid=3",
      "/api/v3/votes?conversation_id=2abc&tid=3",
    ],
    ["/2abc", "/2abc"],
  ])("%s -> %s", (url, expected) => {
    expect(redactUrlForLog(url)).toBe(expected);
  });
});

describe("middleware_http_json_logger", () => {
  test("logs the path, status and timing of a request but not its xid", () => {
    const previousDevMode = process.env.DEV_MODE;
    let logged: { level: unknown; message: unknown; meta: unknown } | undefined;
    try {
      jest.isolateModules(() => {
        // The access log is only written outside dev mode.
        process.env.DEV_MODE = "false";
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const logger = require("../../src/utils/logger").default;
        jest
          .spyOn(logger, "log")
          .mockImplementation(
            (level: unknown, message: unknown, meta: unknown) => {
              logged = { level, message, meta };
              return logger;
            }
          );
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const middleware = require("../../src/server-middleware");
        const { middleware_http_json_logger } = middleware;

        const req = {
          method: "GET",
          originalUrl:
            "/api/v3/participationInit?conversation_id=2abc&xid=person-42&pid=-1",
          ip: "203.0.113.5",
          headers: { "user-agent": "jest" },
        };
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
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

    expect(logged).toBeDefined();
    expect(logged!.level).toBe("info");
    expect(logged!.message).toBe("http_request");
    const meta = logged!.meta as Record<string, unknown>;
    expect(meta.http).toEqual({
      method: "GET",
      url: "/api/v3/participationInit?conversation_id=2abc&xid=[redacted]&pid=-1",
      route: undefined,
      status_code: 200,
    });
    expect(meta.network).toEqual({ client: { ip: "203.0.113.5" } });
    expect(meta.useragent).toBe("jest");
    expect(typeof meta.duration_ms).toBe("number");
    expect(JSON.stringify(logged)).not.toContain("person-42");
  });
});
