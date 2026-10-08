import fs from "node:fs";

// Generated prompt fixture isolates provider retirement from pre-existing missing
// uncertainty/groups template paths. No model or storage I/O leaves the process.
jest.mock("fs/promises", () => ({
  __esModule: true,
  default: { readFile: jest.fn().mockResolvedValue("<polisAnalysisPrompt><data><content /></data></polisAnalysisPrompt>") },
}));
const mockCreate = jest.fn();
const mockError = jest.fn();
const mockRows = new Map<string, any[]>();
const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockDeleteAll = jest.fn();
const mockGetAll = jest.fn();
const mockRead = jest.fn();
const mockInit = jest.fn();
const mockStorageOptions: boolean[] = [];
const mockSummary = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest
    .fn()
    .mockImplementation(() => ({ messages: { create: mockCreate } })),
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { anthropicApiKey: "public-fixture-key" },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: mockError,
    info: jest.fn(),
  },
}));
jest.mock("../../src/report", () => ({
  sendCommentGroupsSummary: (...args: any[]) => mockSummary(...args),
}));
jest.mock("../../src/utils/zinvite", () => ({
  getZidForRid: jest.fn().mockResolvedValue(7),
}));
jest.mock("../../src/utils/storage", () => ({
  __esModule: true,
  default: class {
    disabled: boolean;
    constructor(_table: string, disabled = false) {
      this.disabled = disabled;
      mockStorageOptions.push(disabled);
    }
    initTable = mockInit;
    putItem = mockPut;
    deleteReportItem = mockDelete;
    deleteAllByReportID = mockDeleteAll;
    getAllByReportID = mockGetAll;
    queryItemsByRidSectionModel(key: string) {
      mockRead(key);
      return Promise.resolve({
        success: true,
        data: this.disabled ? [] : mockRows.get(key) || [],
      });
    }
  },
}));
const {
  handle_GET_reportNarrative,
  handle_GET_topics,
} = require("../../src/routes/reportNarrative");
const RID = "r9001generated";
const sections = [
  "group_informed_consensus",
  "uncertainty_narrative",
  "participant_groups",
];
const timestamp = "2026-10-08T00:00:00.000Z";
const captures: Record<string, any> = {};
function row(section: string, model: string, stamp = timestamp) {
  return {
    rid_section_model: `${RID}#${section}#${model}`,
    timestamp: stamp,
    report_id: RID,
    model,
    report_data: JSON.stringify({ title: `stored ${section}`, paragraphs: [] }),
  };
}
function seed(model: string, stamp = timestamp) {
  for (const section of sections)
    mockRows.set(`${RID}#${section}#${model}`, [row(section, model, stamp)]);
}
function response() {
  const chunks: string[] = [];
  return {
    chunks,
    write: jest.fn((s: string) => chunks.push(s)),
    writeHead: jest.fn(),
    flush: jest.fn(),
    end: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    set: jest.fn().mockReturnThis(),
  };
}
async function run(name: string, query: any = {}, delphiEnabled = true) {
  const res = response();
  await handle_GET_reportNarrative(
    { p: { rid: RID, delphiEnabled }, query },
    res
  );
  captures[name] = {
    chunks: res.chunks,
    status: res.status.mock.calls,
    json: res.json.mock.calls,
    writes: mockPut.mock.calls,
    deletes: mockDelete.mock.calls,
    deletesAll: mockDeleteAll.mock.calls,
    calls: mockCreate.mock.calls.map(([request]) => ({
      model: request.model,
      max_tokens: request.max_tokens,
    })),
    ended: res.end.mock.calls.length,
    errors: mockError.mock.calls.map((args) => args.map((a) => a instanceof Error ? a.message : a)),
  };
  return res;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockRows.clear();
  mockStorageOptions.length = 0;
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "setTimeout"] });
  jest.setSystemTime(new Date(timestamp));
  mockCreate.mockResolvedValue({
    content: [
      {
        type: "text",
        text: '```json\n{"title":"generated","paragraphs":[]}\n```',
      },
    ],
    stop_reason: "end_turn",
  });
  mockPut.mockResolvedValue({ success: true });
  mockDelete.mockImplementation(async (key: string) => {
    mockRows.delete(key);
    return { success: true };
  });
  mockDeleteAll.mockImplementation(async () => {
    const n = mockRows.size;
    mockRows.clear();
    return { success: true, deletedCount: n };
  });
  mockGetAll.mockImplementation(async () => ({
    success: true,
    data: [...mockRows.values()].flat(),
  }));
  mockInit.mockResolvedValue({ success: true });
  mockSummary.mockResolvedValue(
    "comment-id,comment,total-votes,total-agrees,total-disagrees,total-passes,group-a-votes,group-a-agrees,group-a-disagrees,group-a-passes\n1,Public fixture,2,2,0,0,2,2,0,0\n"
  );
});
afterEach(() => jest.useRealTimers());
afterAll(() => {
  if (process.env.PROVIDER_RECORDINGS_OUT)
    fs.writeFileSync(
      process.env.PROVIDER_RECORDINGS_OUT,
      JSON.stringify(captures, null, 2) + "\n"
    );
});

test("default new narratives use only the unchanged Anthropic profile", async () => {
  const res = await run("default-miss");
  expect(mockCreate).toHaveBeenCalledTimes(3);
  expect(
    mockCreate.mock.calls.every(
      ([r]) =>
        r.model === "claude-sonnet-5" &&
        r.max_tokens === 8000 &&
        r.output_config.effort === "medium"
    )
  ).toBe(true);
  expect(mockPut).toHaveBeenCalledTimes(3);
  expect(
    mockPut.mock.calls.every(
      ([r]) =>
        r.model === "claude" &&
        r.report_data === '{"title":"generated","paragraphs":[]}'
    )
  ).toBe(true);
  expect(res.end).toHaveBeenCalledTimes(1);
});
test("explicit Anthropic model version is retained", async () => {
  await run("claude-version", {
    model: "claude",
    modelVersion: "fixture-profile",
  });
  expect(
    mockCreate.mock.calls.every(([r]) => r.model === "fixture-profile")
  ).toBe(true);
});
test.each(["openai", "gemini"])(
  "%s stale cached outputs survive noCache and make zero model calls",
  async (model) => {
    seed(model, "2020-01-01T00:00:00.000Z");
    const res = await run(`${model}-old-cache`, { model, noCache: "true" });
    for (const section of sections)
      expect(res.chunks.join("")).toContain(`stored ${section}`);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockDeleteAll).not.toHaveBeenCalled();
    expect(mockStorageOptions).toEqual([false]);
  }
);
test.each(["openai", "gemini"])(
  "%s misses are explicit stored-only errors without writes",
  async (model) => {
    const res = await run(`${model}-miss`, { model });
    expect(
      res.chunks.filter((s) => s.includes("Generation is no longer available"))
    ).toHaveLength(4);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  }
);
test.each(["openai", "gemini", "claude"])(
  "%s stored topic citations and data are unchanged",
  async (model) => {
    seed(model);
    mockRows.set(`${RID}#topics`, [
      { report_data: [{ name: "Public Transit", citations: [1, 4] }] },
    ]);
    const data = '{"title":"Public Transit","citations":[1,4]}';
    mockRows.set(`${RID}#topic_public_transit#${model}`, [
      { report_data: data },
    ]);
    const res = await run(`${model}-stored-topic`, { model });
    expect(res.chunks).toContain(
      JSON.stringify({ topic_public_transit: { modelResponse: data, model } }) +
        "|||"
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  }
);
test("Anthropic refresh preserves retired rows and all stored topics", async () => {
  for (const model of ["claude", "openai", "gemini"])
    seed(model, "2020-01-01T00:00:00.000Z");
  mockRows.set(`${RID}#topics`, [
    {
      rid_section_model: `${RID}#topics`,
      report_data: [{ name: "Transit", citations: [1] }],
      timestamp: "2020-01-01T00:00:00.000Z",
    },
  ]);
  mockRows.set(`${RID}#topic_transit#claude`, [
    row("topic_transit", "claude", "2020-01-01T00:00:00.000Z"),
  ]);
  const res = await run("claude-refresh", { model: "claude" });
  expect(mockDelete).toHaveBeenCalledTimes(3);
  expect(mockDeleteAll).not.toHaveBeenCalled();
  expect(mockCreate).toHaveBeenCalledTimes(3);
  expect(res.chunks.join("")).toContain("stored topic_transit");
  expect(mockRows.has(`${RID}#group_informed_consensus#openai`)).toBe(true);
  expect(mockRows.has(`${RID}#group_informed_consensus#gemini`)).toBe(true);
  expect(mockRows.has(`${RID}#topics`)).toBe(true);
});
test("noCache cannot bypass the retained topic store", async () => {
  seed("claude");
  mockRows.set(`${RID}#topics`, [
    { report_data: [{ name: "Transit", citations: [1] }] },
  ]);
  mockRows.set(`${RID}#topic_transit#claude`, [row("topic_transit", "claude")]);
  const res = await run("claude-noCache", { model: "claude", noCache: "true" });
  expect(mockCreate).toHaveBeenCalledTimes(3);
  expect(res.chunks.join("")).toContain("stored topic_transit");
  expect(
    mockPut.mock.calls.some(([r]) => r.rid_section_model.includes("#topic"))
  ).toBe(false);
});
test("missing stored topics are not rediscovered or written", async () => {
  seed("claude");
  const res = await run("claude-topic-miss", { model: "claude" });
  expect(res.chunks.join("")).toContain("Generation is no longer available");
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
});
test("missing stored topic narrative is not generated", async () => {
  seed("claude");
  mockRows.set(`${RID}#topics`, [
    { report_data: [{ name: "Transit", citations: [1] }] },
  ]);
  const res = await run("claude-topic-section-miss", { model: "claude" });
  expect(res.chunks.join("")).toContain('"topic_transit":{"error":');
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
});
test("unsupported model is refused without model or storage writes", async () => {
  const res = await run("unsupported", { model: "unconfigured" });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
});
test("authorization refusal stays before model calls", async () => {
  const res = await run("unauthorized", {}, false);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
});
test("topic storage errors do not start replacement work", async () => {
  const storage = {
    queryItemsByRidSectionModel: jest
      .fn()
      .mockResolvedValue({ success: false, error: { isNetworkError: true } }),
  };
  const res = response();
  await handle_GET_topics(RID, storage, res, "claude");
  expect(res.chunks.join("")).toContain("Storage service connection error");
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
});
