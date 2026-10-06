import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import { STORAGE_AGREE_VALUE } from "../../src/votes/convention";

jest.mock("sqs-consumer", () => ({ Consumer: { create: jest.fn() } }));
jest.mock("../../src/utils/sqs", () => ({ sqsClient: {} }));
jest.mock("../../src/workers/import-processor", () => ({
  processImportJob: jest.fn(),
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { SQS_QUEUE_URL: "https://queue.example.invalid/public-import" },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), log: jest.fn() },
}));
// The worker reads the database's vote convention before it consumes
// anything (P-078); the stand-in answers the two startup queries.
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn() },
}));

/** What the stand-in database declares: rows for the convention query. */
type Declared = Array<Record<string, unknown>>;
const DECLARED_TODAY: Declared = [
  { version: 0, agree_value: STORAGE_AGREE_VALUE, contract_version: 1 },
];

/** Let the worker's startup promise settle. */
async function settled() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function loadConsumer(
  queue = "https://queue.example.invalid/public-import",
  declared: Declared = DECLARED_TODAY
) {
  let settings: any;
  let processJob: jest.Mock;
  let app: { on: jest.Mock; start: jest.Mock };
  let logger: { error: jest.Mock };
  jest.isolateModules(() => {
    const { Consumer } = require("sqs-consumer");
    const config = require("../../src/config").default;
    config.SQS_QUEUE_URL = queue;
    processJob = require("../../src/workers/import-processor").processImportJob;
    logger = require("../../src/utils/logger").default;
    const pg = require("../../src/db/pg-query").default;
    pg.queryP.mockImplementation(async (sql: string) =>
      sql.includes("to_regclass") ? [{ present: true }] : declared
    );
    app = { on: jest.fn(), start: jest.fn() };
    Consumer.create.mockImplementation((options: any) => {
      settings = options;
      return app;
    });
    require("../../src/workers/start-import-worker");
  });
  await settled();
  return { settings, processJob: processJob!, app: app!, logger: logger! };
}

beforeEach(() => jest.resetAllMocks());

describe("import queue acknowledgement boundary", () => {
  test("starts a single-message consumer and acknowledges only after processing resolves", async () => {
    const { settings, processJob, app } = await loadConsumer();
    expect(settings.batchSize).toBe(1);
    expect(settings.queueUrl).toBe(
      "https://queue.example.invalid/public-import"
    );
    expect(app.start).toHaveBeenCalledTimes(1);
    let complete!: () => void;
    processJob.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      })
    );
    const payload = {
      jobId: 11,
      zid: 7,
      s3Key: "public/import.csv",
      email: "",
    };
    const message = {
      MessageId: "public-message",
      Body: JSON.stringify(payload),
    };
    let acknowledged = false;
    const pending = settings.handleMessage(message).then((value: unknown) => {
      acknowledged = true;
      return value;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(processJob).toHaveBeenCalledWith(payload);
    complete();
    await expect(pending).resolves.toBe(message);
  });

  test("processor failure propagates so the queue message remains eligible for retry", async () => {
    const { settings, processJob } = await loadConsumer();
    const error = new Error("database unavailable");
    processJob.mockRejectedValue(error as never);
    await expect(settings.handleMessage({ Body: '{"jobId":11}' })).rejects.toBe(
      error
    );
  });

  test("malformed JSON fails before invoking the processor", async () => {
    const { settings, processJob } = await loadConsumer();
    await expect(
      settings.handleMessage({ Body: "not-json" })
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(processJob).not.toHaveBeenCalled();
  });

  test("an empty-body message is acknowledged without dispatching an import", async () => {
    const { settings, processJob } = await loadConsumer();
    const message = { MessageId: "empty-public-message" };
    await expect(settings.handleMessage(message)).resolves.toBe(message);
    expect(processJob).not.toHaveBeenCalled();
  });

  test("missing queue configuration exits before creating a consumer", async () => {
    const stopped = new Error("public-test-exit");
    const exit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw stopped;
    });
    try {
      await expect(loadConsumer("")).rejects.toBe(stopped);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});

describe("the worker refuses a database that does not declare this build's vote convention", () => {
  test("undeclared: no message is consumed, the operator command is logged, the process exits 1", async () => {
    const exit = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const { app, logger } = await loadConsumer(undefined, []);
      expect(app.start).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(logger.error.mock.calls[0][0]);
      expect(message).toContain("Polis cannot start (import worker)");
      expect(message).toContain("make vote-convention-declare AGREE=");
    } finally {
      exit.mockRestore();
    }
  });

  test("the other sign: refused as a mismatch", async () => {
    const exit = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const { app, logger } = await loadConsumer(undefined, [
        { version: 1, agree_value: -STORAGE_AGREE_VALUE, contract_version: 1 },
      ]);
      expect(app.start).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(logger.error.mock.calls[0][0])).toContain(
        "every vote inverted"
      );
    } finally {
      exit.mockRestore();
    }
  });
});
