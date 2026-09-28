import { test } from "@jest/globals";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { parse } from "csv-parse";

// Actual exported orchestration and actual CSV parser. Report export, provider
// classes, config and logger are explicit boundaries; no provider request,
// database access, model output generation or hidden helper extraction.
const filename = path.resolve(
  __dirname,
  "../../src/report_experimental/topics-example/index.ts"
);
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  reportDiagnostics: true,
});
assert.equal(
  compiled.diagnostics.filter(
    (item) => item.category === ts.DiagnosticCategory.Error
  ).length,
  0
);
const row = '7,"Public, quoted text",12,6,4,2,7,3,2,2,5,3,2,0';
const csv = "ignored original header\n" + row + "\n";
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture(options: any = {}) {
  const calls = [],
    models = [],
    errors = [],
    tallies = [];
  const topics = options.topics || [{ name: "Public topic" }];
  const dependencies = {
    "../../report": {
      async sendCommentGroupsSummary(...args) {
        calls.push({ operation: "summary", args });
        if (options.summary) return options.summary(...args);
        return options.csv === undefined ? csv : options.csv;
      },
    },
    "@tevko/sensemaking-tools/src/models/aiStudio_model": {
      GoogleAIModel: class {
        constructor(...args) {
          models.push(args);
        }
      },
    },
    "@tevko/sensemaking-tools/src/sensemaker": {
      Sensemaker: class {
        constructor(options) {
          calls.push({ operation: "construct", options });
        }
        async learnTopics(...args) {
          calls.push({ operation: "learn", args });
          return options.learn ? options.learn(...args) : topics;
        }
        async categorizeComments(...args) {
          calls.push({ operation: "categorize", args });
          return options.categorize
            ? options.categorize(...args)
            : options.categorized || [];
        }
      },
    },
    "@tevko/sensemaking-tools/src/types": {
      VoteTally: class {
        agree: number;
        disagree: number;
        pass: number;
        constructor(agree, disagree, pass) {
          Object.assign(this, { agree, disagree, pass });
          tallies.push([agree, disagree, pass]);
        }
      },
    },
    "csv-parse": { parse },
    "../../config": {
      default: {
        geminiApiKey:
          options.key === undefined
            ? "public-provider-placeholder"
            : options.key,
      },
      __esModule: true,
    },
    "../../utils/logger": {
      default: { error: (error) => errors.push(error) },
      __esModule: true,
    },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(
    compiled.outputText,
    {
      module,
      exports: module.exports,
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), name);
        return dependencies[name];
      },
    },
    { filename }
  );
  return {
    run: module.exports.getTopicsFromRID,
    calls,
    models,
    errors,
    tallies,
    topics,
  };
}

test("missing provider key stops before report export or provider construction", async () => {
  const f = fixture({ key: "" });
  assert.deepEqual(plain(await f.run(7)), []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.models, []);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].message, "polis_err_gemini_api_key_not_set");
});

test("report export binds its arguments and real CSV parsing preserves quoted text and numeric tallies", async () => {
  const f = fixture();
  await f.run(7);
  assert.deepEqual(plain(f.calls[0]), {
    operation: "summary",
    args: [7, null, false],
  });
  assert.equal(f.calls[0].args[1], undefined);
  const comments = f.calls.find((call) => call.operation === "learn").args[0];
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "7");
  assert.equal(comments[0].text, "Public, quoted text");
  assert.deepEqual(f.tallies, [
    [3, 2, 2],
    [3, 2, 0],
  ]);
  assert.equal(comments[0].voteTalliesByGroup["group-0"].agree, 3);
  assert.equal(comments[0].voteTalliesByGroup["group-1"].pass, 0);
});

test("learning precedes categorization with the same comments and learned topics identities", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ learn: () => waiting });
  const pending = f.run(7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.filter((call) => call.operation === "learn").length, 1);
  assert.equal(
    f.calls.filter((call) => call.operation === "categorize").length,
    0
  );
  const topics = [{ name: "Public learned topic" }];
  release(topics);
  await pending;
  const learned = f.calls.find((call) => call.operation === "learn");
  const categorized = f.calls.find((call) => call.operation === "categorize");
  assert.equal(categorized.args[0], learned.args[0]);
  assert.equal(learned.args[1], false);
  assert.equal(categorized.args[1], false);
  assert.equal(categorized.args[2], topics);
  assert.deepEqual(
    f.models.map((args) => args[1]),
    ["gemini-exp-1206", "gemini-1.5-flash-8b"]
  );
});

test("topic aggregation preserves first encounter order and all numeric citations including repeats", async () => {
  const f = fixture({
    categorized: [
      { id: "7", topics: [{ name: "Second" }, { name: "First" }] },
      {
        id: "08",
        topics: [{ name: "First" }, { name: "Second" }, { name: "First" }],
      },
      { id: "9" },
    ],
  });
  assert.deepEqual(plain(await f.run(7)), [
    { name: "Second", citations: [7, 8] },
    { name: "First", citations: [7, 8, 8] },
  ]);
});

test("header-only export still calls providers with an empty comment collection", async () => {
  const f = fixture({ csv: "original header\n" });
  assert.deepEqual(plain(await f.run(7)), []);
  const learned = f.calls.find((call) => call.operation === "learn");
  assert.deepEqual(plain(learned.args[0]), []);
  assert.equal(
    f.calls.filter((call) => call.operation === "categorize").length,
    1
  );
  assert.deepEqual(f.errors, []);
});

test("export failures return an empty result and preserve the logged error identity", async () => {
  const failure = new Error("public export failure"),
    f = fixture({
      summary: async () => {
        throw failure;
      },
    });
  assert.deepEqual(plain(await f.run(7)), []);
  assert.deepEqual(f.models, []);
  assert.equal(f.errors[0], failure);
});

test("malformed quoted CSV fails before provider construction through the real parser", async () => {
  const f = fixture({ csv: 'header\n7,"unterminated\n' });
  assert.deepEqual(plain(await f.run(7)), []);
  assert.deepEqual(f.models, []);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, "CSV_QUOTE_NOT_CLOSED");
});

test("learning rejection prevents categorization and returns empty with one logged error", async () => {
  const failure = new Error("public learning failure"),
    f = fixture({
      learn: async () => {
        throw failure;
      },
    });
  assert.deepEqual(plain(await f.run(7)), []);
  assert.equal(
    f.calls.filter((call) => call.operation === "categorize").length,
    0
  );
  assert.equal(f.models.length, 1);
  assert.deepEqual(f.errors, [failure]);
});

test("categorization rejection returns empty after completed learning", async () => {
  const failure = new Error("public categorization failure"),
    f = fixture({
      categorize: async () => {
        throw failure;
      },
    });
  assert.deepEqual(plain(await f.run(7)), []);
  assert.equal(f.models.length, 2);
  assert.equal(f.calls.filter((call) => call.operation === "learn").length, 1);
  assert.deepEqual(f.errors, [failure]);
});

test("overwritten headers discard an input moderation column before the helper can filter it", async () => {
  const f = fixture({
    csv:
      "comment-id,comment_text,total-votes,total-agrees,total-disagrees,total-passes,group-a-votes,group-0-agree-count,group-0-disagree-count,group-0-pass-count,group-b-votes,group-1-agree-count,group-1-disagree-count,group-1-pass-count,moderated\n" +
      row +
      ",-1\n",
  });
  await f.run(7);
  const comments = f.calls.find((call) => call.operation === "learn").args[0];
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "7");
  assert.deepEqual(f.errors, []);
});

test("provider-supplied nonnumeric citation IDs currently become NaN without a validation error", async () => {
  const f = fixture({
    categorized: [{ id: "not-a-number", topics: [{ name: "Public topic" }] }],
  });
  const output = await f.run(7);
  assert.equal(Number.isNaN(output[0].citations[0]), true);
  assert.deepEqual(f.errors, []);
});

test("independent calls do not reuse earlier provider comments or accumulated topic results", async () => {
  let calls = 0;
  const f = fixture({
    categorize: async () => [
      { id: String(++calls), topics: [{ name: "Public topic" }] },
    ],
  });
  const first = await f.run(7),
    second = await f.run(8);
  assert.deepEqual(plain(first), [{ name: "Public topic", citations: [1] }]);
  assert.deepEqual(plain(second), [{ name: "Public topic", citations: [2] }]);
  const learned = f.calls.filter((call) => call.operation === "learn");
  assert.notEqual(learned[0].args[0], learned[1].args[0]);
  assert.deepEqual(
    f.calls
      .filter((call) => call.operation === "summary")
      .map((call) => call.args[0]),
    [7, 8]
  );
});
