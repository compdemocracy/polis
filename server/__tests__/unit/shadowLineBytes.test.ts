/**
 * What Node's real logger writes for the two lines the shadow comparison
 * reads (winston as configured in src/utils/logger.ts, outside dev mode, at
 * info). The access line's `message` is "http_request http_request": winston
 * appends the meta's `message` to the message argument, and the access log
 * passes both. The vote handler's line is "vote_reply". The comparison
 * tool's queries and fixtures (queue-rs/src/bin/polis-shadow) match these
 * spellings; a change here must change them too.
 */
import { describe, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { WIRE_PASS } from "../../src/votes/convention";

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));
jest.mock("../../src/utils/sqs", () => ({ sqsClient: { send: jest.fn() } }));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    query: jest.fn(
      (
        _sql: string,
        _params: unknown[],
        callback: (e: unknown, r: unknown) => void
      ) => callback(null, { rows: [{ created: "1700000000000" }] })
    ),
    query_readOnly: jest.fn(),
    queryP: jest.fn(),
    queryP_readOnly: jest.fn(async () => [{ zid: 7, is_active: true }]),
  },
}));
jest.mock("../../src/utils/fail", () => ({ failJson: jest.fn() }));
jest.mock("../../src/server-helpers", () => ({
  addNoMoreCommentsRecord: jest.fn(),
  addStar: jest.fn(),
  doFamousQuery: jest.fn(),
  finishArray: jest.fn(),
  finishOne: jest.fn(),
  safeTimestampToMillis: jest.fn(() => 1700000000000),
  updateLastInteractionTimeForConversation: jest.fn(),
}));
jest.mock("../../src/nextComment", () => ({
  getNextComment: jest.fn(async () => null),
}));
jest.mock("../../src/user", () => ({}));

const REQUEST_ID = "0123456789abcdef0123456789abcdef";

type Modules = {
  middleware: {
    middleware_http_json_logger: (
      req: unknown,
      res: unknown,
      next: () => void
    ) => void;
  };
  votes: { handle_POST_votes: (req: unknown, res: unknown) => Promise<void> };
};

// Runs `use` with fresh copies of the logger, the middleware and the vote
// handler, outside dev mode at info, and returns the lines the logger wrote.
async function written(use: (m: Modules) => Promise<void>): Promise<string[]> {
  const saved = {
    DEV_MODE: process.env.DEV_MODE,
    SERVER_LOG_LEVEL: process.env.SERVER_LOG_LEVEL,
  };
  const chunks: string[] = [];
  let modules: Modules | undefined;
  process.env.DEV_MODE = "false";
  process.env.SERVER_LOG_LEVEL = "info";
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const logger = require("../../src/utils/logger").default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { transports } = require("winston");
      // The configured logger, with its output captured instead of printed.
      logger.clear();
      logger.add(
        new transports.Stream({
          stream: new Writable({
            write(chunk, _encoding, done) {
              chunks.push(String(chunk));
              done();
            },
          }),
        })
      );
      modules = {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        middleware: require("../../src/server-middleware"),
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        votes: require("../../src/routes/votes"),
      };
    });
    await use(modules as Modules);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return chunks.join("").split("\n").filter(Boolean);
}

describe("the bytes of the shadow comparison's Node lines", () => {
  test('the access line is written "http_request http_request", with request_id', async () => {
    const lines = await written(async ({ middleware }) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      middleware.middleware_http_json_logger(
        {
          method: "POST",
          originalUrl: "/api/v3/votes",
          ip: "203.0.113.5",
          headers: { "user-agent": "jest", "x-request-id": REQUEST_ID },
        },
        res,
        () => undefined
      );
      res.emit("finish");
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"message":"http_request http_request"');
    const line = JSON.parse(lines[0]);
    expect(line.message).toBe("http_request http_request");
    expect(line.level).toBe("info");
    expect(line.service).toBe("server");
    expect(line.request_id).toBe(REQUEST_ID);
    expect(line.http.status_code).toBe(200);
  });

  test('the vote reply is written "vote_reply", with no vote or participant', async () => {
    const lines = await written(async ({ votes }) => {
      await votes.handle_POST_votes(
        {
          headers: { "x-request-id": REQUEST_ID },
          p: {
            zid: 7,
            pid: 4242,
            uid: 9191,
            tid: 3,
            vote: WIRE_PASS,
            lang: "en",
          },
        },
        { status: jest.fn() }
      );
    });
    const replies = lines.filter((l) => l.includes('"vote_reply"'));
    expect(replies).toHaveLength(1);
    const line = JSON.parse(replies[0]);
    expect(line).toMatchObject({
      level: "info",
      message: "vote_reply",
      listener: "shadow",
      route: "POST /api/v3/votes",
      request_id: REQUEST_ID,
      zid: 7,
      node_status: 200,
      node_next: "none",
      service: "server",
    });
    expect(Object.keys(line).sort()).toEqual(
      [
        "level",
        "listener",
        "message",
        "node_next",
        "node_status",
        "request_id",
        "route",
        "service",
        "timestamp",
        "zid",
      ].sort()
    );
    expect(replies[0]).not.toMatch(/4242|9191|"vote"|"pid"/);
  });
});
