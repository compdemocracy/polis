import { beforeEach, describe, expect, jest, test } from "@jest/globals";

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

function loadConsumer(queue = "https://queue.example.invalid/public-import") {
  let settings: any;
  let processJob: jest.Mock;
  let app: { on: jest.Mock; start: jest.Mock };
  jest.isolateModules(() => {
    const { Consumer } = require("sqs-consumer");
    const config = require("../../src/config").default;
    config.SQS_QUEUE_URL = queue;
    processJob = require("../../src/workers/import-processor").processImportJob;
    app = { on: jest.fn(), start: jest.fn() };
    Consumer.create.mockImplementation((options: any) => {
      settings = options;
      return app;
    });
    require("../../src/workers/start-import-worker");
  });
  return { settings, processJob: processJob!, app: app! };
}

beforeEach(() => jest.resetAllMocks());

describe("import queue acknowledgement boundary", () => {
  test("starts a single-message consumer and acknowledges only after processing resolves", async () => {
    const { settings, processJob, app } = loadConsumer();
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
    const { settings, processJob } = loadConsumer();
    const error = new Error("database unavailable");
    processJob.mockRejectedValue(error as never);
    await expect(settings.handleMessage({ Body: '{"jobId":11}' })).rejects.toBe(
      error
    );
  });

  test("malformed JSON fails before invoking the processor", async () => {
    const { settings, processJob } = loadConsumer();
    await expect(
      settings.handleMessage({ Body: "not-json" })
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(processJob).not.toHaveBeenCalled();
  });

  test("an empty-body message is acknowledged without dispatching an import", async () => {
    const { settings, processJob } = loadConsumer();
    const message = { MessageId: "empty-public-message" };
    await expect(settings.handleMessage(message)).resolves.toBe(message);
    expect(processJob).not.toHaveBeenCalled();
  });

  test("missing queue configuration exits before creating a consumer", () => {
    const stopped = new Error("public-test-exit");
    const exit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw stopped;
    });
    try {
      expect(() => loadConsumer("")).toThrow(stopped);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});
