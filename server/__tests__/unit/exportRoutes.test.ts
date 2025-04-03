import {
  formatCSVHeaders,
  formatCSVRow,
  formatCSV,
  loadConversationSummary,
  sendVotesSummary,
  sendParticipantVotesSummary,
  sendParticipantXidsSummary,
} from "../../src/routes/export";
import { queryP_readOnly, stream_queryP_readOnly } from "../../src/db/pg-query";
import { getZinvite } from "../../src/utils/zinvite";
import { getPca } from "../../src/utils/pca";
import { getXids } from "../../src/routes/math";
import { jest } from "@jest/globals";
import logger from "../../src/utils/logger";
import fail from "../../src/utils/fail";

type Formatters<T> = Record<string, (row: T) => string>;

// Define a mock Response type that matches what we're using in tests
interface MockResponse {
  setHeader: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  send?: jest.Mock;
}

// Helper function to create a mock response
function createMockResponse(): MockResponse {
  return {
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    send: jest.fn(),
  };
}

// Helper function to mock stream_queryP_readOnly with row callbacks
function mockStreamWithRows(rows: any[], shouldError = false, error?: Error) {
  return (stream_queryP_readOnly as jest.Mock).mockImplementation(
    (...args: any[]) => {
      if (shouldError) {
        const onError = args[4];
        onError(error || new Error("Test error"));
        return;
      }

      const rowCallback = args[2];
      const onComplete = args[3];

      // Call rowCallback for each row
      rows.forEach(row => rowCallback(row));
      onComplete();
    }
  );
}

jest.mock("../../src/db/pg-query", () => ({
  queryP_readOnly: jest.fn(),
  stream_queryP_readOnly: jest.fn(),
}));

jest.mock("../../src/utils/zinvite", () => ({
  getZinvite: jest.fn(),
  getZidForRid: jest.fn(),
}));

jest.mock("../../src/routes/math", () => ({
  getXids: jest.fn(),
}));

jest.mock("../../src/utils/pca");
jest.mock("../../src/utils/logger");
jest.mock("../../src/utils/fail");

describe("handle_GET_reportExport", () => {
  let mockRes: MockResponse;
  const zid = 123;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRes = createMockResponse();
  });

  describe("CSV formatting functions", () => {
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
  });

  describe("Conversation summary", () => {
    it("loadConversationSummary should load and format conversation summary data", async () => {
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
      const siteUrl = "https://example.com";

      // Mock getZinvite to return undefined (simulating missing data)
      (getZinvite as jest.Mock).mockResolvedValue(undefined as never);

      await expect(loadConversationSummary(zid, siteUrl)).rejects.toThrow(
        "polis_error_data_unknown_report"
      );
    });
  });

  describe("Participant XIDs summary", () => {
    it("sendParticipantXidsSummary should send the participant XIDs as CSV", async () => {
      // Mock the dependencies
      (getPca as jest.Mock).mockResolvedValue({
        asPOJO: {
          "in-conv": [1, 2, 3],
          "user-vote-counts": { 1: 5, 2: 3, 3: 2 },
        },
      } as never);

      // Mock getXids to return sample data
      (getXids as jest.Mock).mockResolvedValue([
        { pid: 1, xid: "user-123" },
        { pid: 2, xid: "user-456" },
        { pid: 3, xid: "user-789" },
      ] as never);

      await sendParticipantXidsSummary(zid, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith("content-type", "text/csv");
      expect(mockRes.send).toHaveBeenCalledWith(
        'participant,xid\n1,"user-123"\n2,"user-456"\n3,"user-789"\n'
      );
    });

    it("sendParticipantXidsSummary should handle empty xids array", async () => {
      // Mock the dependencies
      (getPca as jest.Mock).mockResolvedValue({
        asPOJO: {
          "in-conv": [],
          "user-vote-counts": {},
        },
      } as never);

      // Mock getXids to return an empty array
      (getXids as jest.Mock).mockResolvedValue([] as never);

      await sendParticipantXidsSummary(zid, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith("content-type", "text/csv");
      expect(mockRes.send).toHaveBeenCalledWith('participant,xid\n');
    });

    it("sendParticipantXidsSummary should handle errors during export", async () => {
      const mockError = new Error("polis_error_no_pca_data");

      // Mock getPca to throw an error
      (getPca as jest.Mock).mockRejectedValue(mockError as never);

      await sendParticipantXidsSummary(zid, mockRes as any);

      expect(logger.error).toHaveBeenCalledWith(
        "polis_err_report_participant_xids",
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

  describe("Votes summary", () => {
    it("sendVotesSummary should send the votes summary as CSV", async () => {
      // Use the original require approach since it's more compatible with jest.spyOn
      const formatDatetimeSpy = jest.spyOn(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../../src/routes/export"),
        "formatDatetime"
      );
      formatDatetimeSpy.mockReturnValue(
        "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"
      );

      // Mock stream with a single vote row
      mockStreamWithRows([{ timestamp: 94668411, tid: 1, pid: 1, vote: -1 }]);

      await sendVotesSummary(zid, mockRes as any);

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
      const mockError = new Error("Test error");

      // Mock stream with error
      mockStreamWithRows([], true, mockError);

      await sendVotesSummary(zid, mockRes as any);

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
  });

  describe("Participant votes summary", () => {
    // Common PCA data structure for participant tests
    const basePcaData = {
      "in-conv": [1, 2],
      "base-clusters": {
        members: [
          [1], // Base cluster 0 contains participant 1
          [2]  // Base cluster 1 contains participant 2
        ],
        x: [0, 1],
        y: [0, 1],
        id: [0, 1],
        count: [1, 1]
      },
      "group-clusters": [
        { id: 1, center: [0, 0], members: [0] }, // Group 1 contains base cluster 0
        { id: 2, center: [1, 1], members: [1] }  // Group 2 contains base cluster 1
      ],
      "user-vote-counts": { 1: 2, 2: 1 }
    };

    it("sendParticipantVotesSummary should send the participant votes summary as CSV", async () => {
      // Mock pgQueryP_readOnly to return comment data
      (queryP_readOnly as jest.Mock).mockResolvedValueOnce([
        { tid: 1, pid: 1 },
        { tid: 2, pid: 1 },
        { tid: 3, pid: 2 },
      ] as never);

      // Mock getPca to return properly structured PCA data
      (getPca as jest.Mock).mockResolvedValue({
        asPOJO: basePcaData,
      } as never);

      // Mock stream with vote rows
      mockStreamWithRows([
        { pid: 1, tid: 1, vote: -1 },
        { pid: 1, tid: 2, vote: 1 },
        { pid: 2, tid: 3, vote: -1 }
      ]);

      await sendParticipantVotesSummary(zid, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith("content-type", "text/csv");
      expect(mockRes.write).toHaveBeenCalledWith(
        "participant,group-id,n-comments,n-votes,n-agree,n-disagree,1,2,3\n"
      );
      // Check if the participant rows are correctly formatted
      expect(mockRes.write).toHaveBeenCalledWith("1,1,2,2,1,1,1,-1,\n");
      expect(mockRes.write).toHaveBeenCalledWith("2,2,1,1,1,0,,,1\n");
      expect(mockRes.end).toHaveBeenCalled();
    });

    it("sendParticipantVotesSummary should handle errors during participant vote summary export", async () => {
      const mockError = new Error("Test error");

      // Mock pgQueryP_readOnly to return an empty array
      (queryP_readOnly as jest.Mock).mockResolvedValueOnce([] as never);

      // Mock stream with error
      mockStreamWithRows([], true, mockError);

      await sendParticipantVotesSummary(zid, mockRes as any);

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

    it("sendParticipantVotesSummary should handle participants not found in any base cluster", async () => {
      // Mock pgQueryP_readOnly to return comment data
      (queryP_readOnly as jest.Mock).mockResolvedValueOnce([
        { tid: 1, pid: 1 },
        { tid: 2, pid: 3 }, // Participant 3 is in in-conv but not in any base cluster
      ] as never);

      // Create a modified PCA data with participant 3 in in-conv but not in any base cluster
      const modifiedPcaData = {
        ...basePcaData,
        "in-conv": [1, 2, 3], // Participant 3 is in in-conv
        "user-vote-counts": { 1: 1, 3: 1 },
        "pca": {
          "comps": [
            [0, 1, 0.5], // First dimension for participants 1, 2, 3
            [0, 1, 0.5]  // Second dimension for participants 1, 2, 3
          ],
          "center": [0, 0]
        }
      };

      // Mock getPca with the modified data
      (getPca as jest.Mock).mockResolvedValue({
        asPOJO: modifiedPcaData,
      } as never);

      // Mock stream with vote rows
      mockStreamWithRows([
        { pid: 1, tid: 1, vote: -1 },
        { pid: 3, tid: 2, vote: -1 }
      ]);

      await sendParticipantVotesSummary(zid, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith("content-type", "text/csv");
      expect(mockRes.write).toHaveBeenCalledWith(
        "participant,group-id,n-comments,n-votes,n-agree,n-disagree,1,2\n"
      );

      // Participant 1 should have a group ID
      expect(mockRes.write).toHaveBeenCalledWith("1,1,1,1,1,0,1,\n");

      // Participant 3 should not have a group ID (empty field)
      // Note: The vote is flipped from -1 to 1 in the code
      expect(mockRes.write).toHaveBeenCalledWith("3,,1,1,1,0,,1\n");

      expect(mockRes.end).toHaveBeenCalled();
    });

    it("sendParticipantVotesSummary should correctly map participants to groups when base-cluster IDs are not sequential", async () => {
      const zid = 789;
      const mockResNonSequential = createMockResponse();

      // 1. Mock comment data (pgQueryP_readOnly)
      (queryP_readOnly as jest.Mock).mockResolvedValueOnce([
        { tid: 101, pid: 10 }, // Participant 10 authored comment 101
        { tid: 102, pid: 20 }, // Participant 20 authored comment 102
        { tid: 103, pid: 30 }, // Participant 30 authored comment 103 (will be in-conv but no group)
        { tid: 104, pid: 40 }, // Participant 40 authored comment 104 (not in PCA)
      ] as never);

      // 2. Mock PCA data (getPca)
      const pcaDataWithNonSequentialBaseClusterIds = {
        "in-conv": [10, 20, 30], // Participants 10, 20, 30 are in the conversation
        "base-clusters": {
          members: [
            [10],     // Base cluster at index 0 (ID 55) has participant 10
            [20],     // Base cluster at index 1 (ID 66) has participant 20
            /* Participant 30 is in-conv but not in any base-cluster members list here to test that path */
          ],
          x: [0.1, 0.2],
          y: [0.1, 0.2],
          id: [55, 66], // Actual base cluster IDs are 55 and 66 (non-sequential with index)
          count: [1, 1]
        },
        "group-clusters": [
          { id: 7, center: [0.1, 0.1], members: [55] }, // Group 7 contains base cluster 55
          { id: 8, center: [0.2, 0.2], members: [66] }, // Group 8 contains base cluster 66
        ],
        "user-vote-counts": { 10: 1, 20: 1, 30: 1 }
      };
      (getPca as jest.Mock).mockResolvedValue({
        asPOJO: pcaDataWithNonSequentialBaseClusterIds,
      } as never);

      // 3. Mock votes data (stream_queryP_readOnly)
      mockStreamWithRows([
        { pid: 10, tid: 101, vote: -1 }, // Participant 10 voted on their comment (agree)
        { pid: 20, tid: 102, vote: 1 },  // Participant 20 voted on their comment (disagree)
        { pid: 30, tid: 103, vote: -1} // Participant 30 voted on their comment (agree)
      ]);

      await sendParticipantVotesSummary(zid, mockResNonSequential as any);

      expect(mockResNonSequential.setHeader).toHaveBeenCalledWith("content-type", "text/csv");
      // Header should now include all tids from the mocked queryP_readOnly call for comments
      expect(mockResNonSequential.write).toHaveBeenCalledWith(
        "participant,group-id,n-comments,n-votes,n-agree,n-disagree,101,102,103,104\n"
      );

      // Participant 10 (pid 10) should be in group 7
      expect(mockResNonSequential.write).toHaveBeenCalledWith("10,7,1,1,1,0,1,,,\n");
      // Participant 20 (pid 20) should be in group 8. Vote was 1, flipped to -1.
      expect(mockResNonSequential.write).toHaveBeenCalledWith("20,8,1,1,0,1,,-1,,\n");
      // Participant 30 (pid 30) is in-conv but not in a base-cluster that maps to a group cluster (or not in base-cluster.members)
      // It has 1 comment, 1 vote (agree, which is -1, flipped to 1)
      expect(mockResNonSequential.write).toHaveBeenCalledWith("30,,1,1,1,0,,,1,\n");
      expect(mockResNonSequential.end).toHaveBeenCalled();
    });
  });
});
