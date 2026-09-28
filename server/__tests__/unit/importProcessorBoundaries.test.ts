import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { Readable } from "node:stream";

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetObjectCommand: class {
    operation = "get";
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class {
    operation = "delete";
    constructor(public input: unknown) {}
  },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn(), connect: jest.fn() },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    AWS_S3_BUCKET_NAME: "public-import-fixture",
    polisFromAddress: "sender@example.invalid",
  },
}));
jest.mock("../../src/email/senders", () => ({ sendTextEmail: jest.fn() }));

import pg from "../../src/db/pg-query";
import logger from "../../src/utils/logger";
import { sendTextEmail } from "../../src/email/senders";
import { processImportJob, s3Client } from "../../src/workers/import-processor";

const query = jest.mocked(pg.queryP);
const connect = jest.mocked(pg.connect);
const send = s3Client.send as jest.Mock;
const mail = jest.mocked(sendTextEmail);
const payload = {
  jobId: 11,
  zid: 7,
  s3Key: "public/import.csv",
  email: "reader@example.invalid",
};
const header = "vote_id,user_id,vote_value,timestamp,comment_id\n";
const events: string[] = [];
let csv: string;
let client: { query: jest.Mock; release: jest.Mock };

function jobUpdates(status: string) {
  return query.mock.calls.filter(([sql]) =>
    String(sql).includes(`status = '${status}'`)
  );
}
function voteInserts() {
  return client.query.mock.calls.filter(([sql]) =>
    String(sql).includes("INSERT INTO votes (")
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  events.length = 0;
  csv = header + "v1,public-one,1,2024-01-01T00:00:00Z,comment-one\n";
  client = {
    query: jest.fn(async (sql: unknown, values?: any[]) => {
      const text = String(sql);
      events.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
      if (text.includes("SELECT p.pid")) {
        return {
          rows: [...new Set(values![1])].map((username, pid) => ({
            username,
            pid,
          })),
        };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  connect.mockResolvedValue(client as never);
  query.mockImplementation(async (sql: string) => {
    events.push(sql.replace(/\s+/g, " ").trim());
    return sql.includes("SELECT tid, original_id")
      ? [{ tid: 0, original_id: "comment-one" }]
      : [];
  });
  send.mockImplementation(async (command: any) => {
    events.push("s3:" + command.operation);
    return command.operation === "get" ? { Body: Readable.from([csv]) } : {};
  });
  mail.mockResolvedValue({ $metadata: {} });
});

describe("CSV import transaction and lifecycle boundaries", () => {
  test("maps public CSV signs and comment IDs, retains participant zero, and skips unknown comments", async () => {
    csv += "v2,public-one,-1,2024-01-02T00:00:00Z,comment-one\n";
    csv += "v3,public-two,0,2024-01-03T00:00:00Z,comment-one\n";
    csv += "v4,public-two,1,2024-01-04T00:00:00Z,missing-comment\n";
    await processImportJob(payload);
    expect(voteInserts()).toHaveLength(1);
    expect(voteInserts()[0][1]).toEqual([
      7,
      [0, 0, 1],
      [0, 0, 0],
      [-1, 1, 0],
      [1704067200000, 1704153600000, 1704240000000],
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing-comment")
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(jobUpdates("completed")).toHaveLength(1);
    expect(jobUpdates("failed")).toHaveLength(0);
    expect(events.indexOf("COMMIT")).toBeLessThan(
      events.findIndex((e) => e.startsWith("INSERT INTO votes_latest_unique"))
    );
    const completed = events.findIndex((e) => e.includes("'completed'"));
    const latest = events.findIndex((e) =>
      e.startsWith("INSERT INTO votes_latest_unique")
    );
    const stats = events.findIndex((e) => e.startsWith("WITH ptpt_stats"));
    const tick = events.findIndex((e) =>
      e.startsWith("INSERT INTO math_ticks")
    );
    expect(latest).toBeGreaterThan(-1);
    expect(stats).toBeGreaterThan(latest);
    expect(tick).toBeGreaterThan(stats);
    expect(completed).toBeGreaterThan(tick);
    expect(events.indexOf("s3:delete")).toBeGreaterThan(completed);
    expect(send.mock.calls[0][0]).toEqual({
      operation: "get",
      input: { Bucket: "public-import-fixture", Key: payload.s3Key },
    });
    expect(send.mock.calls[1][0]).toEqual({
      operation: "delete",
      input: { Bucket: "public-import-fixture", Key: payload.s3Key },
    });
    expect(mail).toHaveBeenCalledWith(
      "sender@example.invalid",
      payload.email,
      "Import Successful: Your Data is Ready",
      expect.stringContaining("Processed 3 votes.")
    );
  });

  test("crossing the 1000-row boundary commits every row exactly once in two released batches", async () => {
    csv =
      header +
      Array.from(
        { length: 1001 },
        (_, i) => `v${i},public-one,1,2024-01-01T00:00:00Z,comment-one\n`
      ).join("");
    await processImportJob(payload);
    expect(
      voteInserts().map(([, values]) => (values as any[])[1].length)
    ).toEqual([1000, 1]);
    expect(
      client.query.mock.calls.filter(([sql]) => sql === "COMMIT")
    ).toHaveLength(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(2);
    expect(mail.mock.calls[0][3]).toContain("Processed 1001 votes.");
  });

  test("no mapped comments aborts before downloading or opening a transaction", async () => {
    query.mockResolvedValue([]);
    await expect(processImportJob(payload)).rejects.toThrow(
      "No comments found"
    );
    expect(send).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(jobUpdates("failed")).toHaveLength(1);
    expect(jobUpdates("completed")).toHaveLength(0);
  });

  test("download failure retains the source and original error while marking the job failed", async () => {
    const error = new Error("object unavailable");
    send.mockRejectedValue(error as never);
    await expect(processImportJob(payload)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(jobUpdates("failed")[0][1]).toEqual([11, "object unavailable"]);
    expect(jobUpdates("completed")).toHaveLength(0);
  });

  test("an object without a body cannot be completed or deleted", async () => {
    send.mockResolvedValue({} as never);
    await expect(processImportJob(payload)).rejects.toThrow(
      "Empty body from S3"
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(jobUpdates("failed")).toHaveLength(1);
    expect(connect).not.toHaveBeenCalled();
  });

  test("malformed CSV rejects before flushing partial records", async () => {
    csv = header + 'v1,"unterminated';
    await expect(processImportJob(payload)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    expect(jobUpdates("failed")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("a failed batch rolls back, releases its client and stops derived publication", async () => {
    const original = client.query.getMockImplementation()!;
    const error = new Error("vote insert refused");
    client.query.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes("INSERT INTO votes (")) throw error;
      return original(...args);
    });
    await expect(processImportJob(payload)).rejects.toBe(error);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO votes_latest_unique")
      )
    ).toBe(false);
    expect(jobUpdates("completed")).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("derived-publication failure keeps the uploaded source despite a committed vote batch", async () => {
    const original = query.getMockImplementation()!;
    const error = new Error("latest-vote publication refused");
    query.mockImplementation(async (...args: Parameters<typeof pg.queryP>) => {
      if (String(args[0]).includes("INSERT INTO votes_latest_unique"))
        throw error;
      return original(...args);
    });
    await expect(processImportJob(payload)).rejects.toBe(error);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(jobUpdates("failed")).toHaveLength(1);
    expect(jobUpdates("completed")).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("object cleanup failure does not turn a completed import into a failed job", async () => {
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (command: any) => {
      if (command.operation === "delete") throw new Error("delete unavailable");
      return original(command);
    });
    await expect(processImportJob(payload)).resolves.toBeUndefined();
    expect(jobUpdates("completed")).toHaveLength(1);
    expect(jobUpdates("failed")).toHaveLength(0);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  test("success email failure does not undo a completed import", async () => {
    mail.mockRejectedValue(new Error("mail unavailable"));
    await expect(processImportJob(payload)).resolves.toBeUndefined();
    expect(jobUpdates("completed")).toHaveLength(1);
    expect(jobUpdates("failed")).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("failure-reporting double faults preserve the original import error", async () => {
    const original = query.getMockImplementation()!;
    const error = new Error("original download error");
    send.mockRejectedValue(error as never);
    query.mockImplementation(async (...args: Parameters<typeof pg.queryP>) => {
      if (String(args[0]).includes("status = 'failed'"))
        throw new Error("failure update unavailable");
      return original(...args);
    });
    mail.mockRejectedValue(new Error("failure email unavailable"));
    await expect(processImportJob(payload)).rejects.toBe(error);
    expect(jobUpdates("completed")).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("CRITICAL DOUBLE FAULT")
    );
  });
});
