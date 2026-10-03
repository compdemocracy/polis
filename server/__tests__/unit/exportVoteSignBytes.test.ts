/**
 * Byte pins for the vote columns of the CSV exports. The expected strings were
 * produced by the export code as it stood before the vote convention module
 * (report.ts with its hand-written `-row.vote` flips) and must not change:
 * agree exports as 1, disagree as -1, pass as 0, a NULL vote as 0, and an
 * out-of-range stored value (no CHECK constraint exists) as its negation.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import pg from "../../src/db/pg-query";
import { getPcaFromBundle } from "../../src/utils/pca";
import {
  formatDatetime,
  sendCommentSummary,
  sendParticipantImportance,
  sendParticipantVotesSummary,
  sendVotesSummary,
} from "../../src/report";

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_readOnly: jest.fn(), stream_queryP_readOnly: jest.fn() },
}));
jest.mock("../../src/utils/zinvite", () => ({
  getZinvite: jest.fn(),
  getZidForRid: jest.fn(),
}));
jest.mock("../../src/routes/xids", () => ({ getXids: jest.fn() }));
jest.mock("../../src/utils/pca");
jest.mock("../../src/utils/logger");
jest.mock("../../src/utils/fail");

type Row = Record<string, unknown>;

function streamRows(rows: Row[]) {
  (pg.stream_queryP_readOnly as jest.Mock).mockImplementation(
    (...args: any[]) => {
      rows.forEach((row) => args[2](row));
      args[3]();
    }
  );
}

function capture() {
  const out: string[] = [];
  const res = {
    setHeader: jest.fn(),
    write: jest.fn((s: string) => out.push(s)),
    end: jest.fn(),
    send: jest.fn((s: string) => out.push(s)),
  };
  return { res, text: () => out.join("") };
}

const pcaData = {
  "in-conv": [1, 2],
  "base-clusters": {
    members: [[1], [2]],
    x: [0, 1],
    y: [0, 1],
    id: [0, 1],
    count: [1, 1],
  },
  "group-clusters": [
    { id: 0, center: [0, 0], members: [0] },
    { id: 1, center: [1, 1], members: [1] },
  ],
  "user-vote-counts": { 1: 3, 2: 3 },
};

// Stored values today: agree = -1, disagree = 1, pass = 0, plus NULL and an
// out-of-range 2 that the column admits.
const T = 1700000000000;

beforeEach(() => jest.clearAllMocks());

describe("vote CSV exports keep their bytes", () => {
  test("votes.csv", async () => {
    (pg.queryP_readOnly as jest.Mock).mockResolvedValueOnce([
      { importance_enabled: false },
    ] as never);
    streamRows([
      { timestamp: T, tid: 1, pid: 1, vote: -1 },
      { timestamp: T, tid: 1, pid: 2, vote: 1 },
      { timestamp: T, tid: 2, pid: 1, vote: 0 },
      { timestamp: T, tid: 2, pid: 2, vote: null },
      { timestamp: T, tid: 3, pid: 1, vote: 2 },
    ]);
    const { res, text } = capture();
    await sendVotesSummary(7, res as any);
    const d = formatDatetime(T);
    expect(text()).toBe(
      "timestamp,datetime,comment-id,voter-id,vote\n" +
        `1700000000,${d},1,1,1\n` +
        `1700000000,${d},1,2,-1\n` +
        `1700000000,${d},2,1,0\n` +
        `1700000000,${d},2,2,0\n` +
        `1700000000,${d},3,1,-2\n`
    );
  });

  test("participant-votes.csv", async () => {
    (pg.queryP_readOnly as jest.Mock).mockResolvedValueOnce([
      { tid: 1, pid: 1 },
      { tid: 2, pid: 1 },
      { tid: 3, pid: 2 },
    ] as never);
    (getPcaFromBundle as jest.Mock).mockResolvedValue({
      asPOJO: pcaData,
    } as never);
    streamRows([
      { pid: 1, tid: 1, vote: -1 },
      { pid: 1, tid: 2, vote: 1 },
      { pid: 1, tid: 3, vote: null },
      { pid: 2, tid: 1, vote: 0 },
      { pid: 2, tid: 2, vote: 2 },
      { pid: 2, tid: 4, vote: -1 }, // a tid outside the comment columns
    ]);
    const { res, text } = capture();
    await sendParticipantVotesSummary(7, res as any);
    expect(text()).toBe(
      "participant,group-id,n-comments,n-votes,n-agree,n-disagree,1,2,3\n" +
        "1,0,2,3,1,1,1,-1,0\n" +
        "2,1,1,3,1,0,0,-2,\n"
    );
  });

  test("participant-importance.csv", async () => {
    (pg.queryP_readOnly as jest.Mock).mockResolvedValueOnce([
      { tid: 1, pid: 1 },
      { tid: 2, pid: 1 },
      { tid: 3, pid: 2 },
    ] as never);
    (getPcaFromBundle as jest.Mock).mockResolvedValue({
      asPOJO: pcaData,
    } as never);
    streamRows([
      { pid: 1, tid: 1, vote: -1, high_priority: true },
      { pid: 1, tid: 2, vote: null, high_priority: false },
      { pid: 2, tid: 3, vote: 2, high_priority: true },
      { pid: 2, tid: 4, vote: 1, high_priority: true },
    ]);
    const { res, text } = capture();
    await sendParticipantImportance(7, res as any);
    expect(text()).toBe(
      "participant,group-id,n-comments,n-votes,n-important,1,2,3\n" +
        "1,0,2,2,1,1,0,\n" +
        "2,1,1,1,1,,,1\n"
    );
  });

  test("comments.csv counts", async () => {
    (pg.queryP_readOnly as jest.Mock)
      .mockResolvedValueOnce([{ importance_enabled: false }] as never)
      .mockResolvedValueOnce([
        {
          tid: 1,
          pid: 5,
          created: String(T),
          txt: "a",
          mod: 1,
          velocity: 1,
          active: true,
        },
      ] as never);
    streamRows([
      { tid: 1, vote: -1, high_priority: false },
      { tid: 1, vote: -1, high_priority: false },
      { tid: 1, vote: 1, high_priority: false },
      { tid: 1, vote: 0, high_priority: false },
      { tid: 1, vote: null, high_priority: false },
      { tid: 1, vote: 2, high_priority: false },
    ]);
    const { res, text } = capture();
    await sendCommentSummary(7, res as any);
    expect(text()).toBe(
      "timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,comment-body\n" +
        `1700000000,${formatDatetime(String(T) as any)},1,5,2,1,1,"a"\n`
    );
  });
});
