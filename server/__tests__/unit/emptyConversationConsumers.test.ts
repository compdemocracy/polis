import { beforeEach, expect, jest, test } from "@jest/globals";
import express from "express";
import fs from "fs";
import path from "path";
import request from "supertest";

const queryP_readOnly = jest.fn();

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP_readOnly,
    queryP: queryP_readOnly,
    // callback style, used by routes/participation.ts:71 (_getParticipant)
    query_readOnly: (_sql: string, _params: any[], cb: any) =>
      cb(null, { rows: [{ zid: 1, uid: 7, pid: 11 }] }),
  },
}));

jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { mathEnv: "test-math-env", cacheMathResults: true },
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: () => undefined,
    silly: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

jest.mock("../../src/utils/metered", () => ({
  __esModule: true,
  addInRamMetric: () => undefined,
  // Called both as `new MPromise(name, resolver)` and, in
  // routes/participation.ts:67, as a bare `MPromise(name, resolver)`. A plain
  // function returning an object satisfies both.
  MPromise: function (_name: string, resolver: any) {
    return new Promise(resolver);
  },
}));

jest.mock("../../src/user", () => ({
  __esModule: true,
  getPidPromise: () => Promise.resolve(11),
  getPid: () => Promise.resolve(11),
  getUser: () => Promise.resolve({ uid: 7, pid: 11, hname: "t" }),
}));

jest.mock("../../src/utils/zinvite", () => ({
  __esModule: true,
  getZidForRid: () => Promise.resolve(1),
  getZinvite: () => Promise.resolve("synthetic"),
}));

jest.mock("../../src/utils/common", () => ({
  __esModule: true,
  default: { isModerator: () => Promise.resolve(true) },
  isConversationOwner: () => Promise.resolve(true),
  isOwner: () => Promise.resolve(true),
}));

// Collaborators of handle_GET_participationInit. Only `../../src/utils/pca` is
// left real -- that is the module under test.
jest.mock("../../src/participant", () => ({
  __esModule: true,
  addExtendedParticipantInfo: () => Promise.resolve(),
  joinConversation: () => Promise.resolve({ pid: 11 }),
}));
jest.mock("../../src/conversation", () => ({
  __esModule: true,
  getConversationInfo: () => Promise.resolve({ zid: 1 }),
}));
jest.mock("../../src/nextComment", () => ({
  __esModule: true,
  getNextComment: () => Promise.resolve(null),
}));
jest.mock("../../src/routes/votes", () => ({
  __esModule: true,
  getVotesForSingleParticipant: () => Promise.resolve([]),
}));
jest.mock("../../src/xids", () => ({
  __esModule: true,
  getXidRecord: () => Promise.resolve([]),
}));
jest.mock("../../src/routes/xids", () => ({
  __esModule: true,
  getXids: () => Promise.resolve([]),
}));
jest.mock("../../src/db/sql", () => ({
  __esModule: true,
  sql_participants_extended: {},
}));
jest.mock("../../src/server-helpers", () => ({
  __esModule: true,
  doFamousQuery: jest.fn(() => Promise.resolve({})),
  updateLastInteractionTimeForConversation: () => undefined,
  getOneConversation: () => Promise.resolve({ zid: 1, topic: "t" }),
  userHasAnsweredZeQuestions: () => Promise.resolve(true),
}));

jest.mock("../../src/utils/commentClusters", () => ({
  getCommentsWithClusters: () => Promise.resolve([]),
}));
import {
  getPca,
  getPcaFromBundle,
  getLatestExistingPca,
  prefetchLatestPcaData,
  wasMergedWithTemplate,
} from "../../src/utils/pca";
import { presentPca } from "../../src/utils/pcaPresentation";
import { handle_GET_bidToPid } from "../../src/routes/math";
import { handle_GET_participationInit } from "../../src/routes/participation";
import { doFamousQuery } from "../../src/server-helpers";
import {
  loadConversationSummary,
  sendCommentGroupsSummary,
  sendParticipantXidsSummary,
} from "../../src/report";

const contract = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../../delphi/scripts/schedules/pc-zerovote-01-empty.json"
    ),
    "utf8"
  )
).empty_output;
// Moderation lists are conversation state, not compute output: they left the
// constant contract and Python emits them as lists (empty here: no moderated comments).
const moderationLists: Record<string, unknown> = {
  "mod-in": [],
  "mod-out": [],
};
const pinned: Record<string, unknown> = { ...contract, ...moderationLists };
let zid = 960000;
beforeEach(() => {
  zid++;
  queryP_readOnly.mockReset();
  jest.clearAllMocks();
});
function serve(tick = -1, data = {}) {
  queryP_readOnly.mockImplementation(((sql: string) => {
    if (sql.includes("as main_data"))
      return Promise.resolve([
        {
          main_data: data,
          main_math_tick: String(tick),
          main_caching_tick: "1",
          bidtopid_data: { bidToPid: [] },
          bidtopid_math_tick: String(tick),
          ptptstats_data: {},
          ptptstats_math_tick: String(tick),
          ticks_math_tick: String(tick),
        },
      ]);
    if (sql.includes("from math_main"))
      return Promise.resolve([{ zid, data, math_tick: tick, caching_tick: 1 }]);
    if (sql.includes("COUNT(DISTINCT")) return Promise.resolve([{ count: 0 }]);
    if (sql.includes("FROM conversations"))
      return Promise.resolve([{ topic: "Empty", description: "Synthetic" }]);
    return Promise.resolve([]);
  }) as never);
}
function response() {
  const res: any = {
    json: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
    write: jest.fn(),
  };
  res.status = jest.fn(() => res);
  return res;
}
async function bid(rows: any[]) {
  queryP_readOnly.mockImplementation((() => Promise.resolve(rows)) as never);
  const res = response();
  handle_GET_bidToPid({ p: { zid, math_tick: -1 } }, res);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}
test("missing mapping returns 304, never an empty 200 object", async () => {
  const res = await bid([]);
  expect(res.status).toHaveBeenCalledWith(304);
  expect(res.end).toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
});
test("existing empty mapping remains a successful mapping", async () => {
  const res = await bid([{ data: { math_tick: 0, bidToPid: [] } }]);
  expect(res.json).toHaveBeenCalledWith({ bidToPid: [] });
  expect(res.status).not.toHaveBeenCalled();
});
test("prefetch applies the shared template and marks its presentation", async () => {
  serve(2);
  await prefetchLatestPcaData();
  const cached = await getPca(zid);
  expect(wasMergedWithTemplate(cached?.asPOJO)).toBe(true);
  expect(cached?.asPOJO.consensus).toEqual(contract.consensus);
  expect(cached?.consensus).toEqual(contract.consensus);
  expect(cached?.asPOJO.n).toBe(contract.n);
  expect((await presentPca(zid, cached))?.asPOJO.pca.center).toEqual([0, 0]);
});
test("an unticked bundle becomes empty presentation without exposing its stale contents", async () => {
  serve(-1, { n: 99 });
  const result = await getPcaFromBundle(zid);
  expect(result?.asPOJO.n).toBe(contract.n);
  expect(result?.asPOJO.math_tick).toBe(0);
  expect(wasMergedWithTemplate(result?.asPOJO)).toBe(true);
  expect(await getLatestExistingPca(zid)).toBeUndefined();
});
test("summary CSV presents an unticked row", async () => {
  serve();
  const rows = await loadConversationSummary(zid, "https://example.invalid");
  expect(rows).toContain("voters,0");
  expect(rows).toContain("groups,0");
});
test("comment group CSV is header only for an unticked row", async () => {
  serve();
  const csv = await sendCommentGroupsSummary(zid, undefined, false);
  expect(csv).toContain("comment");
  expect(csv.trim().split("\n")).toHaveLength(1);
});
test("xid export does not need math at all", async () => {
  queryP_readOnly.mockImplementation((() => {
    throw new Error("unneeded math read");
  }) as never);
  const res = response();
  await sendParticipantXidsSummary(zid, res);
  expect(res.send).toHaveBeenCalledWith("participant,xid\n");
  expect(res.status).not.toHaveBeenCalled();
  expect(queryP_readOnly).not.toHaveBeenCalled();
});
test.each([0, 7])(
  "participationInit passes served tick %i to the famous query",
  async (tick) => {
    serve(tick);
    const res = response();
    await handle_GET_participationInit(
      {
        p: {
          zid,
          conversation_id: "public-fixture",
          lang: "en",
          pid: 11,
          participantInfo: { uid: 7, pid: 11 },
          uid: 7,
        },
      } as any,
      res
    );
    expect(doFamousQuery).toHaveBeenCalledWith(
      expect.objectContaining({ math_tick: tick })
    );
  }
);

// Engine contract versus server presentation, as requested in board [1156].
// These are deliberate existing presentation differences, NOT science values.
const presentationDifferences = {
  "mod-in": {
    row: [],
    missing: undefined,
    reason:
      "Rows normalize null moderation to an array; no-row template omits moderation.",
  },
  "mod-out": {
    row: [],
    missing: undefined,
    reason:
      "Rows normalize null moderation to an array; no-row template omits moderation.",
  },
  "pca.center": {
    row: [0, 0],
    missing: [0, 0],
    reason:
      "The contract declares no center for a zero-vote conversation; the presenter supplies the historical display default either way.",
  },
  "pca.comment-projection": {
    row: {},
    missing: {},
    reason:
      "The contract declares no projections; the presenter supplies the historical empty object either way.",
  },
  "pca.comment-extremity": {
    row: [],
    missing: [],
    reason:
      "The contract declares no extremities; the presenter fills from the empty comments table either way.",
  },
  lastVoteTimestamp: {
    row: contract.lastVoteTimestamp,
    missing: 123456789,
    reason:
      "No-row fallback uses wall-clock time; published empty rows use timestamp zero.",
  },
};
function emptyRow(legacy: boolean) {
  const data: any = {
    pca: { comps: [[], []] },
    "base-clusters": { x: [], y: [], id: [], count: [], members: [] },
  };
  for (const [key, value] of Object.entries(pinned)) {
    const parts = key.split(".");
    if (parts.length === 2) data[parts[0]][parts[1]] = structuredClone(value);
    else data[key] = structuredClone(value);
  }
  if (legacy) {
    const schedule = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "../../../delphi/scripts/schedules/pc-zerovote-01-empty.json"
        ),
        "utf8"
      )
    );
    for (const key of [
      ...schedule.legacy_absent_keys,
      ...schedule.legacy_absent_moderation,
    ]) {
      const parts = key.split(".");
      if (parts.length === 2) delete data[parts[0]][parts[1]];
      else delete data[key];
    }
  }
  return data;
}
import { handle_GET_math_pca2 } from "../../src/routes/math";
test.each(["python", "legacy", "missing"])(
  "all fourteen contract paths and both moderation lists are pinned on presentation, PCA2 and participationInit: %s",
  async (kind) => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(123456789);
    try {
      if (kind === "missing")
        queryP_readOnly.mockImplementation((() =>
          Promise.resolve([])) as never);
      else serve(0, emptyRow(kind === "legacy"));
      const presented = await presentPca(zid, await getPca(zid));
      const app = express();
      app.get("/pca", (_req, res) =>
        handle_GET_math_pca2(
          { p: { zid, math_tick: -1, ifNoneMatch: undefined } },
          res as any
        )
      );
      const wire = await request(app).get("/pca");
      expect(wire.status).toBe(200);
      const participation = response();
      await handle_GET_participationInit(
        {
          p: {
            zid,
            conversation_id: "public-fixture",
            lang: "en",
            pid: 11,
            participantInfo: { uid: 7, pid: 11 },
            uid: 7,
          },
        } as any,
        participation
      );
      const init = participation.json.mock.calls[0][0].pca;
      expect(Object.keys(contract)).toHaveLength(14);
      expect(Object.keys(pinned)).toHaveLength(16);
      for (const pojo of [
        presented!.asPOJO,
        wire.body,
        init.asPOJO,
        JSON.parse(init.asJSON),
      ]) {
        for (const [key, value] of Object.entries(pinned)) {
          const difference = presentationDifferences[key];
          const expected = difference
            ? kind === "missing"
              ? difference.missing
              : difference[kind] ?? difference.row
            : value;
          // JSON serializes IEEE negative zero as zero on the wire.
          expect(
            JSON.stringify(key.split(".").reduce((o, k) => o?.[k], pojo))
          ).toBe(JSON.stringify(expected));
          if (difference) expect(difference.reason.length).toBeGreaterThan(0);
        }
      }
      expect(presented!.asJSON).toBe(init.asJSON);
      expect(JSON.parse(presented!.asJSON)).toEqual(wire.body);
    } finally {
      clock.mockRestore();
    }
  }
);
