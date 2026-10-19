const mockSend = jest.fn();
const mockQuery = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: jest.fn() }));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  QueryCommand: class {
    kind = "query";
    constructor(public input: any) {}
  },
  GetCommand: class {
    kind = "get";
    constructor(public input: any) {}
  },
  TransactWriteCommand: class {
    kind = "write";
    constructor(public input: any) {}
  },
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { mathEnv: "python" },
}));
// Every query goes to the agent-exchange pool; a participation pool throws.
jest.mock("../../src/db/pg-query", () => {
  const participation = () => {
    throw new Error("participation pool used");
  };
  return {
    __esModule: true,
    default: {
      queryP_agentExchange: (...a: any[]) => mockQuery(...a),
      queryP_reportExport: (...a: any[]) => mockQuery(...a),
      queryP: participation,
      queryP_readOnly: participation,
      connect: participation,
    },
  };
});
import {
  handle_GET_collective_inputs as get,
  handle_GET_collective_results as list,
  handle_POST_collective_results as post,
  collectiveSchema,
  consensusFor,
} from "../../src/routes/delphi/collectiveExchange";
const topic = "job4201#0#1";
const query = {
  conversation_id: "demo4201",
  report_id: "rdemo4201",
  section: topic,
};
const math = {
  "group-votes": {
    0: {
      "n-members": 20,
      votes: {
        0: { A: 18, D: 0, S: 20 },
        1: { A: 18, D: 0, S: 20 },
        2: { A: 18, D: 0, S: 20 },
      },
    },
  },
};
let comments: any[];
let receipt: any;
let statements: any[];
let mathTick: number;
let writes: any[];
let deny = false;
let changed = false;
function res(): any {
  const r: any = { code: 200, setHeader: jest.fn() };
  r.status = (c: number) => {
    r.code = c;
    return r;
  };
  r.json = (v: any) => {
    r.data = v;
    return r;
  };
  return r;
}
const req = (extra = {}) => ({ p: { uid: 10 }, query, ...extra } as any);
async function exported() {
  const r = res();
  await get(req(), r);
  expect(r.code).toBe(200);
  return r.data;
}
function authored(m: any) {
  return {
    schema_version: 1,
    conversation_id: m.conversation_id,
    report_id: m.report_id,
    export_id: m.export_id,
    input_digest: m.input_digest,
    section: topic,
    model: "external-writer",
    prompt_sha256: "a".repeat(64),
    runner: "generated-runner",
    results: [
      {
        section: topic,
        report_data: {
          id: "collective_statement",
          title: "Candidate",
          paragraphs: [
            {
              id: "shared",
              title: "Common ground",
              sentences: [
                {
                  clauses: [
                    { text: "We support the cited proposal.", citations: [0] },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  receipt = null;
  statements = [];
  mathTick = 3;
  writes = [];
  deny = false;
  changed = false;
  comments = [0, 1, 2].map((i) => ({
    comment_id: i,
    comment_text: "Evidence " + i,
    mod: 0,
    active: true,
    total_votes: 20,
    agrees: 18,
    disagrees: 0,
    passes: 2,
  }));
  mockQuery.mockImplementation(async (sql: string) =>
    sql.startsWith("SELECT c.zid")
      ? deny
        ? []
        : [{ zid: 4201 }]
      : sql.startsWith("SELECT zid FROM reports")
      ? deny
        ? []
        : [{ zid: 4201 }]
      : sql.startsWith("SELECT data")
      ? [{ data: math, math_tick: mathTick }]
      : comments
  );
  mockSend.mockImplementation(async (c: any) => {
    if (c.kind === "get")
      return {
        Item:
          c.input.TableName === "Delphi_CollectiveStatement"
            ? statements.find(
                (s) => s.zid_topic_jobid === c.input.Key.zid_topic_jobid
              )
            : receipt,
      };
    if (c.kind === "write") {
      writes.push(c.input);
      statements.push(
        ...c.input.TransactItems.map((x: any) => x.Put)
          .filter((x: any) => x.TableName === "Delphi_CollectiveStatement")
          .map((x: any) => x.Item)
      );
      return {};
    }
    if (c.input.TableName === "Delphi_CollectiveStatement")
      return { Items: statements };
    if (c.input.TableName.includes("TopicNames"))
      return {
        Items: [
          {
            topic_key: changed ? "other#0#1" : topic,
            topic_name: "Test topic",
          },
        ],
      };
    return {
      Items: [0, 1, 2].map((i) => ({ comment_id: i, layer0_cluster_id: 1 })),
    };
  });
});
test("exports semantic counts, comment zero and exact topic; private no-store response", async () => {
  const m = await exported();
  expect(m.sections[0].citation_ids).toEqual([0, 1, 2]);
  expect(m.sections[0].comments[0].agrees).toBe(18);
  expect(typeof m.sections[0].comments[0].consensus).toBe("string");
  expect(m.policy).toContain("legacy");
  expect(writes).toHaveLength(0);
});
test.each(["get", "post"])(
  "anonymous %s denied before storage",
  async (method) => {
    const r = res();
    await (method === "get" ? get : post)(req({ p: {} }), r);
    expect(r.code).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  }
);
test("wrong owner/report denied before reads", async () => {
  deny = true;
  const r = res();
  await get(req(), r);
  expect(r.code).toBe(403);
  expect(mockSend).not.toHaveBeenCalled();
});
test("unknown exact topic refused, never as 404 (the CLI reads 404 as unserved)", async () => {
  changed = true;
  const r = res();
  await get(req(), r);
  expect(r.code).toBe(422);
  expect(r.data.code).toBe("TOPIC_NOT_FOUND");
});
test("math no writer has committed is refused", async () => {
  mathTick = -1;
  const r = res();
  await get(req(), r);
  expect(r.code).toBe(409);
  expect(r.data.code).toBe("NO_MATH");
});
test("insufficient consensus refused", async () => {
  comments = comments.slice(0, 2);
  const r = res();
  await get(req(), r);
  expect(r.code).toBe(409);
  expect(r.data.code).toBe("INSUFFICIENT_CONSENSUS");
});
test("atomic import has public provenance and private actor receipt", async () => {
  const b = authored(await exported());
  const r = res();
  await post(req({ body: b }), r);
  expect(r.code).toBe(200);
  expect(writes).toHaveLength(1);
  const puts = writes[0].TransactItems.map((x: any) => x.Put);
  expect(puts[0].TableName).toBe("Delphi_NarrativeReports");
  expect(puts[0].Item.metadata.imported_by).toBe(10);
  expect(puts[0].Item.zid).toBeUndefined();
  expect(puts[1].Item.provenance).toBe("external agent");
  expect(puts[1].Item.imported_by).toBeUndefined();
  expect(puts.every((p: any) => p.ConditionExpression)).toBe(true);
});
test("provenance is stored with the statement and returned with the receipt", async () => {
  const b = authored(await exported());
  const r = res();
  await post(req({ body: b }), r);
  const item = writes[0].TransactItems[1].Put.Item;
  const expected = {
    provenance: "external agent",
    model: "external-writer",
    prompt_sha256: "a".repeat(64),
    runner: "generated-runner",
    math_tick: "3",
    export_id: b.export_id,
    input_digest: b.input_digest,
    policy: "report-consensus-v1-legacy-A+D+S",
  };
  expect(item).toMatchObject(expected);
  expect(new Date(item.created_at).toISOString()).toBe(item.created_at);
  expect(r.data.provenance).toEqual({
    ...expected,
    created_at: item.created_at,
  });
  // Unstated prompt and runner are stored as null, never guessed.
  const bare: any = authored(await exported());
  delete bare.prompt_sha256;
  delete bare.runner;
  const r2 = res();
  await post(req({ body: bare }), r2);
  expect(r2.data.provenance).toMatchObject({
    prompt_sha256: null,
    runner: null,
  });
});
test("the result schema names collective statements and bounds provenance", async () => {
  expect(collectiveSchema.title).toBe(
    "External agent collective statement import v1"
  );
  expect(collectiveSchema.required).not.toContain("prompt_sha256");
  expect(collectiveSchema.required).not.toContain("runner");
  for (const [field, value] of [
    ["prompt_sha256", "A".repeat(64)],
    ["runner", "x".repeat(101)],
    ["runner", "<script>"],
  ]) {
    const b: any = authored(await exported());
    b[field] = value;
    const r = res();
    await post(req({ body: b }), r);
    expect(r.code).toBe(400);
  }
  expect(writes).toHaveLength(0);
});
test("identical retry deduplicates; conflict refused", async () => {
  const b = authored(await exported());
  await post(req({ body: b }), res());
  receipt = writes[0].TransactItems[0].Put.Item;
  const r = res();
  await post(req({ body: b }), r);
  expect(r.data.deduplicated).toBe(true);
  expect(r.data.provenance.created_at).toBe(statements[0].created_at);
  b.model = "Different";
  const bad = res();
  await post(req({ body: b }), bad);
  expect(bad.code).toBe(409);
  expect(writes).toHaveLength(1);
});
test("comment drift refuses stale digest", async () => {
  const b = authored(await exported());
  comments[0].comment_text = "Changed";
  const r = res();
  await post(req({ body: b }), r);
  expect(r.data.code).toBe("STALE_COLLECTIVE_INPUTS");
  expect(writes).toHaveLength(0);
});
test("ownership revocation during preparation refuses publication", async () => {
  const b = authored(await exported());
  let checks = 0;
  const original = mockQuery.getMockImplementation()!;
  mockQuery.mockImplementation((sql: string, ...args: any[]) =>
    sql.startsWith("SELECT c.zid") && ++checks === 2
      ? []
      : original(sql, ...args)
  );
  const r = res();
  await post(req({ body: b }), r);
  expect(r.code).toBe(403);
  expect(writes).toHaveLength(0);
});
test.each(["citation", "extra", "empty", "topic", "depth"])(
  "rejects invalid %s before writes",
  async (kind) => {
    const b = authored(await exported());
    const clause =
      b.results[0].report_data.paragraphs[0].sentences[0].clauses[0];
    if (kind === "citation") clause.citations = [999];
    if (kind === "extra") (b as any).actor = 8;
    if (kind === "empty") clause.citations = [];
    if (kind === "topic") b.results[0].section = "other#0#1";
    if (kind === "depth") (clause as any).text = { bad: { nested: [] } };
    const r = res();
    await post(req({ body: b }), r);
    expect(r.code).toBe(400);
    expect(writes).toHaveLength(0);
  }
);
test("storage errors are sanitized", async () => {
  mockSend.mockRejectedValue(new Error("private internal detail"));
  const r = res();
  await get(req(), r);
  expect(r.code).toBe(503);
  expect(JSON.stringify(r.data)).not.toContain("private internal detail");
});
test("existing participation rule and missing groups remain explicit", () => {
  expect(consensusFor(0, math).qualifying).toBe(true);
  expect(consensusFor(9, math).qualifying).toBe(false);
  expect(consensusFor(0, {}).qualifying).toBe(false);
});
test("paged topic query reads later pages", async () => {
  const original = mockSend.getMockImplementation()!;
  mockSend.mockImplementation((c: any) =>
    c.kind === "query" &&
    c.input.TableName.includes("TopicNames") &&
    !c.input.ExclusiveStartKey
      ? {
          Items: [],
          LastEvaluatedKey: { conversation_id: "4201", topic_key: "early" },
        }
      : original(c)
  );
  expect((await exported()).sections).toHaveLength(1);
});

test("dynamodb backend keeps the conditional transaction and receipt key", async () => {
  const b = authored(await exported());
  const r = res();
  await post(req({ body: b }), r);
  expect(r.code).toBe(200);
  const get = mockSend.mock.calls.find((c: any) => c[0].kind === "get")[0]
    .input;
  expect(get.Key).toEqual({
    rid_section_model: `external-import#4201#${b.export_id}`,
    timestamp: "receipt",
  });
  expect(
    writes[0].TransactItems.map((t: any) => [
      t.Put.TableName,
      t.Put.ConditionExpression,
    ])
  ).toEqual([
    ["Delphi_NarrativeReports", "attribute_not_exists(rid_section_model)"],
    ["Delphi_CollectiveStatement", "attribute_not_exists(zid_topic_jobid)"],
  ]);
  expect(writes[0].TransactItems[1].Put.Item.zid_topic_jobid).toBe(
    `4201#${topic}#${b.export_id}`
  );
});

describe("stored versions", () => {
  const version = (n: number, topic_key = topic) => ({
    zid_topic_jobid: `4201#${topic_key}#external_${n}`,
    zid: "4201",
    topic_key,
    created_at: `2026-10-0${n}T00:00:00.000Z`,
    model: `writer-${n}`,
    provenance: "external agent",
    statement_data: JSON.stringify({ id: `v${n}` }),
    comments_data: "[]",
  });
  test("every version of a topic, newest first, parsed, public", async () => {
    statements = [
      version(1),
      version(3),
      version(2),
      version(4, "job4201#0#2"),
    ];
    const r = res();
    await list({ query: { report_id: "rdemo4201", section: topic } } as any, r);
    expect(r.code).toBe(200);
    expect(r.data.count).toBe(3);
    expect(r.data.statements.map((s: any) => s.model)).toEqual([
      "writer-3",
      "writer-2",
      "writer-1",
    ]);
    expect(r.data.statements[0].statement_data).toEqual({ id: "v3" });
    const index = mockSend.mock.calls.map((c: any) => c[0].input.IndexName);
    expect(index).toContain("zid-created_at-index");
    const all = res();
    await list({ query: { report_id: "rdemo4201" } } as any, all);
    expect(all.data.count).toBe(4);
  });
  test("bad input and unknown reports are refused without a 404", async () => {
    for (const query of [
      {},
      { report_id: "r-bad" },
      { report_id: "rdemo4201", section: "not a topic" },
    ]) {
      const r = res();
      await list({ query } as any, r);
      expect(r.code).toBe(400);
    }
    deny = true;
    const r = res();
    await list({ query: { report_id: "rdemo4201" } } as any, r);
    expect(r.code).toBe(422);
    expect(r.data.code).toBe("REPORT_NOT_FOUND");
  });
});
