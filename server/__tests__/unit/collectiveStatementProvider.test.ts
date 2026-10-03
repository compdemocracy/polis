/**
 * The collective statement's provider switch (LLM_PROVIDER) and the
 * provenance stored with each statement. Every model call is mocked: the
 * Anthropic SDK by a jest mock, Ollama by a stubbed fetch. The comments are
 * generated fixtures.
 */
import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";

const mockSend = jest.fn<(command: any) => Promise<any>>();
const mockAnthropicCreate = jest.fn<(params: any) => Promise<any>>();
const mockConfig: Record<string, any> = {};

jest.mock("../../src/config", () => ({
  __esModule: true,
  default: mockConfig,
}));
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => {
  class Command {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  return {
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
    PutCommand: class PutCommand extends Command {},
    GetCommand: class GetCommand extends Command {},
    QueryCommand: class QueryCommand extends Command {},
  };
});
jest.mock("../../src/utils/parameter", () => ({
  getZidFromReport: jest.fn(async () => 7),
}));
jest.mock("../../src/utils/commentClusters", () => ({
  getCommentIdsForCluster: jest.fn(async () => [1, 2, 3]),
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP: jest.fn(async () => [
      {
        comment_id: 1,
        comment_text: "Generated fixture one",
        total_votes: 30,
        agrees: 25,
        disagrees: 2,
        passes: 3,
      },
      {
        comment_id: 2,
        comment_text: "Generated fixture two",
        total_votes: 30,
        agrees: 24,
        disagrees: 3,
        passes: 3,
      },
      {
        comment_id: 3,
        comment_text: "Generated fixture three",
        total_votes: 30,
        agrees: 26,
        disagrees: 1,
        passes: 3,
      },
    ]),
  },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  HOSTED_STATEMENT_MODEL,
  ollamaBaseUrl,
  ollamaChat,
  resolveStatementModel,
  STATEMENT_TIMEOUT_CAP_SECONDS,
  statementTimeoutSeconds,
} from "../../src/utils/statementModel";

const STATEMENT = {
  id: "collective_statement",
  title: "Collective Statement: Parks",
  paragraphs: [
    {
      id: "shared",
      title: "Shared",
      sentences: [{ clauses: [{ text: "We value parks", citations: [1] }] }],
    },
  ],
};

function loadRoute() {
  let route: typeof import("../../src/routes/collectiveStatement");
  jest.isolateModules(() => {
    route = require("../../src/routes/collectiveStatement");
  });
  return route!;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function postReq() {
  return {
    p: { delphiEnabled: true },
    body: {
      report_id: "r123",
      topic_key: "0f0e0d0c-1111-2222-3333-444455556666#0#3",
      topic_name: "Parks",
      qualifying_tids: [1, 2, 3],
      group_consensus: { 1: 0.9, 2: 0.85, 3: 0.95 },
    },
  } as any;
}

function ollamaReply(content: string, status = 200) {
  return new Response(
    JSON.stringify({ message: { role: "assistant", content } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}

let fetchSpy: any;

beforeEach(() => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, {
    anthropicApiKey: "test-key",
    llmProvider: "anthropic",
    ollamaHost: "ollama:11434",
    ollamaModel: "llama3.2:3b",
    ollamaNumCtx: 16384,
    ollamaRequestTimeoutSeconds: 600,
  });
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  mockAnthropicCreate.mockReset();
  fetchSpy = jest.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("resolveStatementModel", () => {
  it("keeps the hosted model unless LLM_PROVIDER is ollama", () => {
    expect(resolveStatementModel("anthropic", "llama3.2:3b")).toEqual({
      provider: "anthropic",
      model: HOSTED_STATEMENT_MODEL,
    });
    expect(resolveStatementModel(undefined, "llama3.2:3b").provider).toBe(
      "anthropic"
    );
    expect(resolveStatementModel("openai", "llama3.2:3b").provider).toBe(
      "anthropic"
    );
    expect(resolveStatementModel(" Ollama ", "llama3.2:3b")).toEqual({
      provider: "ollama",
      model: "llama3.2:3b",
    });
  });

  it("normalises OLLAMA_HOST forms", () => {
    expect(ollamaBaseUrl("ollama:11434")).toBe("http://ollama:11434");
    expect(ollamaBaseUrl("http://host.docker.internal:11434/")).toBe(
      "http://host.docker.internal:11434"
    );
    expect(ollamaBaseUrl(null)).toBe("http://localhost:11434");
  });
});

describe("statementTimeoutSeconds", () => {
  it("caps the local statement timeout below nginx's 300 s", () => {
    expect(STATEMENT_TIMEOUT_CAP_SECONDS).toBeLessThan(300);
    expect(statementTimeoutSeconds(600)).toBe(240);
    expect(statementTimeoutSeconds(90)).toBe(90);
    expect(statementTimeoutSeconds(NaN)).toBe(240);
    expect(statementTimeoutSeconds(0)).toBe(240);
  });
});

describe("ollamaChat", () => {
  const settings = {
    host: "ollama:11434",
    model: "llama3.2:3b",
    numCtx: 8192,
    timeoutSeconds: 5,
  };

  it("sends one non-streaming JSON request with the prompt", async () => {
    const fetchImpl = jest.fn(async (_url: any, _init: any) =>
      ollamaReply('{"a":1}')
    );
    await expect(
      ollamaChat(settings, "sys", "user", 8000, fetchImpl as any)
    ).resolves.toBe('{"a":1}');
    const [url, init] = fetchImpl.mock.calls[0] as [string, any];
    expect(url).toBe("http://ollama:11434/api/chat");
    expect(JSON.parse(init.body)).toEqual({
      model: "llama3.2:3b",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "user" },
      ],
      stream: false,
      format: "json",
      options: { num_predict: 8000, num_ctx: 8192 },
    });
  });

  it("throws on an HTTP error, an empty reply and a timeout", async () => {
    await expect(
      ollamaChat(settings, "s", "u", 10, (async () =>
        ollamaReply("x", 500)) as any)
    ).rejects.toThrow("HTTP 500");
    await expect(
      ollamaChat(settings, "s", "u", 10, (async () => ollamaReply("  ")) as any)
    ).rejects.toThrow("empty");
    const timeout = Object.assign(new Error("timed out"), {
      name: "TimeoutError",
    });
    await expect(
      ollamaChat(settings, "s", "u", 10, (async () => {
        throw timeout;
      }) as any)
    ).rejects.toThrow("timed out after 5s");
  });
});

describe("POST /collectiveStatement provider switch", () => {
  it("anthropic: calls the hosted model as before and records it", async () => {
    mockAnthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(STATEMENT) }],
    });
    const route = loadRoute();
    const res = mockRes();
    await route.handle_POST_collectiveStatement(postReq(), res);

    expect(fetchSpy).not.toHaveBeenCalled();
    const params = mockAnthropicCreate.mock.calls[0][0];
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.max_tokens).toBe(8000);
    expect(params.output_config).toEqual({ effort: "medium" });

    const item = mockSend.mock.calls[0][0].input.Item;
    expect(item.model).toBe("claude-opus-4-8");
    expect(item.provider).toBe("anthropic");
    expect(JSON.parse(item.statement_data)).toEqual(STATEMENT);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      status: "success",
      statementData: STATEMENT,
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
  });

  it("ollama: posts the same prompt to OLLAMA_HOST and stores the provenance", async () => {
    mockConfig.llmProvider = "ollama";
    mockConfig.anthropicApiKey = null; // an offline box has no key
    fetchSpy.mockImplementation(async () =>
      ollamaReply("```json\n" + JSON.stringify(STATEMENT) + "\n```")
    );
    const route = loadRoute();
    const res = mockRes();
    await route.handle_POST_collectiveStatement(postReq(), res);

    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://ollama:11434/api/chat");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("llama3.2:3b");
    expect(sent.messages[1].content).toContain("<topic>\nParks\n</topic>");
    expect(sent.messages[1].content).toContain("Generated fixture one");

    const item = mockSend.mock.calls[0][0].input.Item;
    expect(item).toMatchObject({ provider: "ollama", model: "llama3.2:3b" });
    expect(JSON.parse(item.statement_data)).toEqual(STATEMENT);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      status: "success",
      statementData: STATEMENT,
      provider: "ollama",
      model: "llama3.2:3b",
    });
  });

  it("ollama: malformed output keeps the existing fallback shape, still marked local", async () => {
    mockConfig.llmProvider = "ollama";
    fetchSpy.mockImplementation(async () =>
      ollamaReply("We mostly agree about parks.")
    );
    const route = loadRoute();
    const res = mockRes();
    await route.handle_POST_collectiveStatement(postReq(), res);

    const item = mockSend.mock.calls[0][0].input.Item;
    expect(item.provider).toBe("ollama");
    const data = JSON.parse(item.statement_data);
    expect(data.paragraphs[0].id).toBe("fallback");
    expect(data.paragraphs[0].sentences[0].clauses[0].text).toBe(
      "We mostly agree about parks."
    );
  });

  it("ollama: a failed call stores nothing and answers 500", async () => {
    mockConfig.llmProvider = "ollama";
    fetchSpy.mockImplementation(async () =>
      ollamaReply("model not found", 404)
    );
    const route = loadRoute();
    const res = mockRes();
    await route.handle_POST_collectiveStatement(postReq(), res);

    expect(mockSend).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].error).toContain("HTTP 404");
  });
});
