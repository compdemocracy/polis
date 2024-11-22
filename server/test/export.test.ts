import {
  formatCSVHeaders,
  formatCSVRow,
  formatCSV,
  loadConversationSummary,
  sendVotesSummary,
  formatDatetime,
  sendParticipantVotesSummary,
} from "../src/routes/export";
import { queryP_readOnly, stream_queryP_readOnly } from "../src/db/pg-query";
import { getZinvite } from "../src/utils/zinvite";
import { getPca } from "../src/utils/pca";
import { jest } from "@jest/globals";
import logger from "../src/utils/logger";
import fail from "../src/utils/fail";

type Formatters<T> = Record<string, (row: T) => string>;

jest.mock("../src/db/pg-query", () => ({
  queryP_readOnly: jest.fn(),
  stream_queryP_readOnly: jest.fn(),
}));

jest.mock("../src/utils/zinvite");
jest.mock("../src/utils/pca");
jest.mock("../src/utils/logger");
jest.mock("../src/utils/fail");

describe("handle_GET_reportExport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  const sep = "\n";
  it("formatCSVHeaders should return a comma-separated string of header keys", () => {
    const colFns: Formatters<{ name: string; age: number }> = {
      name: (row) => row.name,
      age: (row) => String(row.age),
    };

    const result = formatCSVHeaders(colFns);

    expect(result).toBe("name,age");
  });

  it("formatCSVHeaders should handle an empty object", () => {
    const colFns: Formatters<any> = {};

    const result = formatCSVHeaders(colFns);

    expect(result).toBe("");
  });

  it("formatCSVRow should format a row as a comma-separated string", () => {
    const row = { name: "John Doe", age: 30 };
    const colFns: Formatters<typeof row> = {
      name: (row) => row.name,
      age: (row) => String(row.age),
    };

    const result = formatCSVRow(row, colFns);

    expect(result).toBe("John Doe,30");
  });

  it("formatCSVRow should handle an empty object of formatters", () => {
    const row = { name: "Jane Doe", age: 25 };
    const colFns: Formatters<typeof row> = {};

    const result = formatCSVRow(row, colFns);

    expect(result).toBe("");
  });

  it("formatCSVRow should handle formatters that return different data types", () => {
    const row = { name: "Alice", age: 28, active: true };
    const colFns: Formatters<typeof row> = {
      name: (row) => row.name,
      age: (row) => String(row.age),
      active: (row) => (row.active ? "yes" : "no"),
    };

    const result = formatCSVRow(row, colFns);

    expect(result).toBe("Alice,28,yes");
  });

  it("formatCSV should format an array of rows as a CSV string", () => {
    const colFns: Formatters<{ name: string; age: number }> = {
      name: (row) => row.name,
      age: (row) => String(row.age),
    };
    const rows = [
      { name: "John Doe", age: 30 },
      { name: "Jane Doe", age: 25 },
    ];

    const result = formatCSV(colFns, rows);

    expect(result).toBe("name,age\nJohn Doe,30\nJane Doe,25\n");
  });

  it("formatCSV should handle an empty array of rows", () => {
    const colFns: Formatters<{ name: string; age: number }> = {
      name: (row) => row.name,
      age: (row) => String(row.age),
    };
    const rows: { name: string; age: number }[] = [];

    const result = formatCSV(colFns, rows);

    expect(result).toBe("name,age\n");
  });

  it("loadConversationSummary should load and format conversation summary data", async () => {
    const zid = 123;
    const siteUrl = "https://example.com";

    // Mock the dependencies
    (getZinvite as jest.Mock).mockResolvedValue("test-zinvite" as never);
    (queryP_readOnly as jest.Mock)
      .mockResolvedValueOnce([
        { topic: "Test Topic", description: "Test Description" },
      ] as never)
      .mockResolvedValueOnce([{ count: 10 }] as never);
    (getPca as jest.Mock).mockResolvedValue({
      asPOJO: {
        "in-conv": [1, 2, 3],
        "user-vote-counts": { 1: 5, 2: 3 },
        "group-clusters": { 1: { name: "Group 1" } },
        "n-cmts": 20,
      },
    } as never);

    const result = await loadConversationSummary(zid, siteUrl);

    expect(result).toEqual([
      'topic,"Test Topic"',
      "url,https://example.com/test-zinvite",
      "voters,2",
      "voters-in-conv,3",
      "commenters,10",
      "comments,20",
      "groups,1",
      'conversation-description,"Test Description"',
    ]);
  });

  it("loadConversationSummary should throw an error if data is missing", async () => {
    const zid = 123;
    const siteUrl = "https://example.com";

    // Mock getZinvite to return undefined (simulating missing data)
    (getZinvite as jest.Mock).mockResolvedValue(undefined as never);

    await expect(loadConversationSummary(zid, siteUrl)).rejects.toThrow(
      "polis_error_data_unknown_report"
    );
  });

  it("sendVotesSummary should send the votes summary as CSV", async () => {
    const mockRes = {
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    const zid = 123;

    const formatDatetimeSpy = jest.spyOn(
      require("../src/routes/export"),
      "formatDatetime"
    );
    formatDatetimeSpy.mockReturnValue(
      "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"
    );

    // Mock stream_pgQueryP_readOnly to simulate data streaming
    (stream_queryP_readOnly as jest.Mock).mockImplementation(
      (_, __, cb, onComplete, onError) => {
        //@ts-expect-error unknown type
        cb({ timestamp: 94668411, tid: 1, pid: 1, vote: -1 });
        //@ts-expect-error unknown type
        onComplete();
      }
    );
    // @ts-expect-error mock response
    await sendVotesSummary(zid, mockRes);

    expect(mockRes.setHeader).toHaveBeenCalledWith("Content-Type", "text/csv");
    expect(mockRes.write).toHaveBeenCalledWith(
      "timestamp,datetime,comment-id,voter-id,vote\n"
    );
    expect(mockRes.write).toHaveBeenCalledWith(
      "94668,Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time),1,1,1\n"
    );
    expect(mockRes.end).toHaveBeenCalled();
  });

  it("sendVotesSummary should handle errors during vote summary export", async () => {
    const mockRes = {
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    const zid = 123;
    const mockError = new Error("Test error");

    // Mock stream_pgQueryP_readOnly to call the onError callback
    (stream_queryP_readOnly as jest.Mock).mockImplementation(
      (_, __, cb, onComplete, onError) => {
        // @ts-expect-error type unknown
        onError(mockError);
      }
    );
    // @ts-expect-error mock response
    await sendVotesSummary(zid, mockRes);

    expect(logger.error).toHaveBeenCalledWith(
      "polis_err_report_votes_csv",
      mockError
    );
    expect(fail).toHaveBeenCalledWith(
      mockRes,
      500,
      "polis_err_data_export",
      mockError
    );
  });

  it("sendParticipantVotesSummary should send the participant votes summary as CSV", async () => {
    const zid = 123;
    const mockRes = {
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };

    // Mock pgQueryP_readOnly to return comment data
    (queryP_readOnly as jest.Mock).mockResolvedValueOnce([
      { tid: 1, pid: 1 },
      { tid: 2, pid: 1 },
      { tid: 3, pid: 2 },
    ] as never);

    // Mock getPca to return group cluster data
    (getPca as jest.Mock).mockResolvedValue({
      asPOJO: {
        "group-clusters": [
          { id: 1, members: [1] },
          { id: 2, members: [2] },
        ],
      },
    } as never);

    // Mock stream_pgQueryP_readOnly to simulate vote streaming
    (stream_queryP_readOnly as jest.Mock).mockImplementation(
      (_, __, cb, onComplete, onError) => {
        // @ts-expect-error unknown func
        cb({ pid: 1, tid: 1, vote: -1 });
        // @ts-expect-error unknown func
        cb({ pid: 1, tid: 2, vote: 1 });
        // @ts-expect-error unknown func
        cb({ pid: 2, tid: 3, vote: -1 });
        // @ts-expect-error unknown func
        onComplete();
      }
    );
    // @ts-expect-error mock response
    await sendParticipantVotesSummary(zid, mockRes);

    expect(mockRes.setHeader).toHaveBeenCalledWith("content-type", "text/csv");
    expect(mockRes.write).toHaveBeenCalledWith(
      "participant,group-id,n-comments,n-votes,n-agree,n-disagree,1,2,3\n"
    );
    // Check if the participant rows are correctly formatted
    expect(mockRes.write).toHaveBeenCalledWith("1,1,2,2,1,1,1,-1,\n");
    expect(mockRes.end).toHaveBeenCalled();
  });

  it("sendParticipantVotesSummary should handle errors during participant vote summary export", async () => {
    const zid = 123;
    const mockError = new Error("Test error");
    const mockRes = {
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };

    // Mock pgQueryP_readOnly to return an empty array
    (queryP_readOnly as jest.Mock).mockResolvedValueOnce([] as never);

    // Mock stream_pgQueryP_readOnly to call onError
    (stream_queryP_readOnly as jest.Mock).mockImplementation(
      (_, __, cb, onComplete, onError) => {
        // @ts-expect-error unknown func
        onError(mockError);
      }
    );
    // @ts-expect-error response mock
    await sendParticipantVotesSummary(zid, mockRes);

    expect(logger.error).toHaveBeenCalledWith(
      "polis_err_report_participant_votes",
      mockError
    );
    expect(fail).toHaveBeenCalledWith(
      mockRes,
      500,
      "polis_err_data_export",
      mockError
    );
  });
});
