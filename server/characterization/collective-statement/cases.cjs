"use strict";
/**
 * Every recorded case of the collective-statement routes, in run order. Each
 * case names the state it exercises; `run(ctx)` drives the real server through
 * ctx (requests, the provider stub's script, polling) and the harness records
 * the response bytes, every provider request, the stored DynamoDB rows the
 * case added or removed, and the server's log lines.
 *
 * Nothing here says what the server SHOULD do. Odd behaviour is recorded as is
 * and listed as a question in the findings, never corrected here.
 */
const F = require("./fixtures.cjs");

const K1 = `${F.JOB_NEW}#0#1`;
const K2 = `${F.JOB_NEW}#0#2`;
const K3 = `${F.JOB_NEW}#0#3`;
const K4 = `${F.JOB_NEW}#0#4`;
const K9 = `${F.JOB_NEW}#0#9`;
const K_OLD = `${F.JOB_OLD}#0#1`;
const R = F.REPORT.main;

// What the browser's gate sends (client-report consensusThreshold.js): the
// tids that passed it and a consensus number per tid. Generated values.
const GC1 = { 0: 0.92, 1: 0.88, 2: 0.85, 3: 0.9, 4: 0.81, 5: 0.83, 7: 0.95 };
const GC2 = { 6: 0.82, 7: 0.91, 8: 0.86, 9: 0.95 };
const GC3 = { 10: 0.97, 11: 0.93 };

const eligible = (extra) => ({
  report_id: R,
  topic_key: K1,
  topic_name: "Generated topic: shared spaces",
  qualifying_tids: [0, 1, 2, 4],
  group_consensus: GC1,
  ...extra,
});

function statementText(title, tids) {
  return JSON.stringify(
    {
      id: "collective_statement",
      title,
      paragraphs: [
        {
          id: "shared_values",
          title: "Our Shared Values",
          sentences: [
            {
              clauses: [
                {
                  text: "We agree that shared spaces matter",
                  citations: tids.slice(0, 2),
                },
                {
                  text: " and should be easy to reach.",
                  citations: tids.slice(2, 3),
                },
              ],
            },
          ],
        },
      ],
    },
    null,
    2
  );
}

const thinking = {
  type: "thinking",
  thinking: "Generated fixture reasoning.",
  signature: "generated-signature",
};
const ok = (
  tids,
  title = "Collective Statement: Generated topic: shared spaces"
) => ({
  kind: "message",
  stop_reason: "end_turn",
  content: [thinking, { type: "text", text: statementText(title, tids) }],
});

/** A POST whose provider script is `script` (empty: no call expected). */
function post(id, about, auth, body, script = []) {
  return {
    id,
    about,
    async run(ctx) {
      ctx.arm(script);
      await ctx.post(body, auth);
    },
  };
}

function get(id, about, auth, path, extra = {}) {
  return {
    id,
    about,
    ...extra,
    async run(ctx) {
      ctx.arm([]);
      await ctx.get(path, auth);
    },
  };
}

function allCases() {
  const cases = [
    // ------------------------------------------------------------- POST: refused
    post(
      "post/missing-topic-name",
      "report_id and topic_key, no topic_name",
      "owner",
      { report_id: R, topic_key: K1 }
    ),
    post("post/unauthenticated", "no bearer token", "none", eligible()),
    post(
      "post/participant-token",
      "an anonymous participant token (no delphi claim)",
      "participant",
      eligible()
    ),
    post(
      "post/oidc-without-delphi-claim",
      "a signed-in account whose token has no delphi_enabled claim",
      "plain",
      eligible()
    ),
    post(
      "post/oidc-delphi-claim-false",
      "a signed-in account with delphi_enabled false",
      "flaggedOff",
      eligible()
    ),
    post(
      "post/unknown-report",
      "a report_id no report has",
      "owner",
      eligible({ report_id: "r1csrecunknown" })
    ),
    post(
      "post/malformed-topic-key",
      "a topic key in neither accepted format",
      "owner",
      eligible({ topic_key: "notakey" })
    ),
    post(
      "post/topic-with-no-members",
      "a well-formed key whose cluster has no comments",
      "owner",
      eligible({ topic_key: K9 })
    ),
    post(
      "post/topic-members-missing-from-postgres",
      "the topic's only member has no comment row",
      "owner",
      eligible({ topic_key: K4 })
    ),
    post(
      "post/one-qualifying-tid",
      "one qualifying tid (fewer than three)",
      "owner",
      eligible({ qualifying_tids: [0] })
    ),
    post(
      "post/qualifying-tids-as-strings",
      "qualifying tids sent as strings",
      "owner",
      eligible({ qualifying_tids: ["0", "1", "2"] })
    ),
    post(
      "post/qualifying-tids-without-group-consensus",
      "qualifying tids and no group_consensus",
      "owner",
      {
        report_id: R,
        topic_key: K1,
        topic_name: "Generated topic: shared spaces",
        qualifying_tids: [0, 1, 2],
      }
    ),

    // ------------------------------------------------------- POST: model called
    post(
      "post/eligible",
      "an eligible topic: client qualifying_tids and group_consensus",
      "owner",
      eligible(),
      [ok([0, 1, 2])]
    ),
    post(
      "post/eligible-tid-outside-topic",
      "a qualifying tid that is not in the topic",
      "owner",
      eligible({ qualifying_tids: [0, 1, 2, 7] }),
      [ok([0, 1, 2])]
    ),
    post(
      "post/eligible-moderated-out-tid",
      "a moderated-out comment among the qualifying tids",
      "owner",
      eligible({ qualifying_tids: [0, 1, 3] }),
      [ok([0, 3, 1])]
    ),
    post(
      "post/no-qualifying-tids-no-consensus",
      "neither qualifying_tids nor group_consensus: the whole topic is sent",
      "owner",
      {
        report_id: R,
        topic_key: K1,
        topic_name: "Generated topic: shared spaces",
      },
      [ok([0, 1, 3])]
    ),
    post(
      "post/legacy-consensus-only",
      "group_consensus only (legacy): >= 20 votes, top quartile",
      "owner",
      {
        report_id: R,
        topic_key: K2,
        topic_name: "Generated topic: streets",
        group_consensus: GC2,
      },
      [ok([7, 6, 8], "Collective Statement: Generated topic: streets")]
    ),
    post(
      "post/legacy-consensus-only-empty-set",
      "group_consensus only, no comment has 20 votes: the model gets an empty set",
      "owner",
      {
        report_id: R,
        topic_key: K3,
        topic_name: "Generated topic: river path",
        group_consensus: GC3,
      },
      [ok([], "Collective Statement: Generated topic: river path")]
    ),
    post(
      "post/older-job-topic-key",
      "a topic key from an older Delphi job",
      "owner",
      eligible({ topic_key: K_OLD }),
      [ok([0, 1, 2])]
    ),
    post(
      "post/underscore-topic-key",
      "the layer<L>_<C> key format",
      "owner",
      eligible({ topic_key: "layer0_1" }),
      [ok([0, 1, 2])]
    ),
    post(
      "post/non-owner-delphi-enabled",
      "a delphi-enabled account that does not own the report",
      "other",
      eligible(),
      [ok([0, 1, 2])]
    ),

    // ---------------------------------------------------- POST: provider output
    post(
      "post/provider-json-in-code-fence",
      "the model wraps its JSON in a code fence",
      "owner",
      eligible(),
      [
        {
          kind: "message",
          stop_reason: "end_turn",
          content: [
            thinking,
            {
              type: "text",
              text:
                "```json\n" +
                statementText(
                  "Collective Statement: Generated topic: shared spaces",
                  [0, 1, 2]
                ) +
                "\n```",
            },
          ],
        },
      ]
    ),
    post(
      "post/provider-truncated-max-tokens",
      "output cut off by max_tokens mid-JSON",
      "owner",
      eligible(),
      [
        {
          kind: "message",
          stop_reason: "max_tokens",
          content: [
            thinking,
            {
              type: "text",
              text: statementText(
                "Collective Statement: Generated topic: shared spaces",
                [0, 1, 2]
              ).slice(0, 180),
            },
          ],
        },
      ]
    ),
    post(
      "post/provider-unparseable-prose",
      "the model answers in prose, not JSON",
      "owner",
      eligible(),
      [
        {
          kind: "message",
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: "We broadly agree that shared spaces matter [0][1].",
            },
          ],
        },
      ]
    ),
    post(
      "post/provider-no-text-block",
      "a response with a thinking block and no text block",
      "owner",
      eligible(),
      [{ kind: "message", stop_reason: "max_tokens", content: [thinking] }]
    ),

    // ---------------------------------------------------- POST: provider errors
    post(
      "post/provider-429-every-attempt",
      "the provider rate-limits every attempt",
      "owner",
      eligible(),
      [0, 1, 2].map(() => ({
        kind: "status",
        status: 429,
        error: { type: "rate_limit_error", message: "Generated rate limit." },
      }))
    ),
    post(
      "post/provider-500-then-success",
      "one provider 500, then a success on the SDK's retry",
      "owner",
      eligible(),
      [
        {
          kind: "status",
          status: 500,
          error: { type: "api_error", message: "Generated internal error." },
        },
        ok([0, 1, 2]),
      ]
    ),
    post(
      "post/provider-400-invalid-request",
      "the provider refuses the request (not retried)",
      "owner",
      eligible(),
      [
        {
          kind: "status",
          status: 400,
          error: {
            type: "invalid_request_error",
            message: "Generated invalid request.",
          },
        },
      ]
    ),
    post(
      "post/provider-connection-reset",
      "the provider connection drops on every attempt",
      "owner",
      eligible(),
      [0, 1, 2].map(() => ({ kind: "reset" }))
    ),
    {
      id: "post/provider-slower-than-proxy",
      about:
        "the provider is still working when the caller gives up (as the proxy does at its read timeout): the caller's connection is closed, then the provider answers",
      async run(ctx) {
        ctx.arm([{ kind: "hold", then: ok([0, 1, 2]) }]);
        const before = await ctx.storedCount();
        const call = ctx.postAbortable(eligible(), "owner");
        await ctx.poll(
          "the provider holds the request",
          () => ctx.stub.state.pending.length === 1
        );
        ctx.note(
          "caller had a response before the provider answered",
          call.answered()
        );
        call.abort();
        await ctx.poll("the caller's connection is closed", () =>
          call.closed()
        );
        ctx.note("provider replies released", ctx.stub.release());
        await ctx.poll(
          "a row is stored after the caller left",
          async () => (await ctx.storedCount()) > before
        );
      },
    },
    {
      id: "post/dynamodb-write-fails-after-call",
      about:
        "the statement table refuses the write after the model has answered",
      async before(ctx) {
        await ctx.dropStatementTable();
      },
      async after(ctx) {
        await ctx.restoreStatementTable();
      },
      async run(ctx) {
        ctx.arm([ok([0, 1, 2])]);
        await ctx.post(eligible(), "owner");
      },
    },
    {
      id: "post/concurrent-first-requests",
      about:
        "two first requests for the same topic at once (two tabs, or the page and the modal)",
      unordered: ["provider", "logs", "uuids"],
      async run(ctx) {
        ctx.arm([
          { kind: "hold", then: ok([0, 1, 2]) },
          { kind: "hold", then: ok([0, 1, 2]) },
        ]);
        const a = ctx.postAsync(
          eligible({
            topic_key: K2,
            qualifying_tids: [6, 7, 8],
            group_consensus: GC2,
          }),
          "owner"
        );
        const b = ctx.postAsync(
          eligible({
            topic_key: K2,
            qualifying_tids: [6, 7, 8],
            group_consensus: GC2,
          }),
          "owner"
        );
        const both = await ctx.poll(
          "both requests reach the provider",
          () => ctx.stub.state.pending.length >= 2,
          { orElse: true }
        );
        ctx.note(
          "provider requests in flight at once",
          both ? 2 : ctx.stub.state.pending.length
        );
        ctx.stub.release();
        await a;
        await b;
      },
    },

    // --------------------------------------------------------------------- GET
    get(
      "get/none-stored",
      "a report with no stored statement, no token",
      "none",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.none}`
    ),
    get(
      "get/one-stored",
      "a report with one stored statement, no token",
      "none",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.one}`
    ),
    get(
      "get/several-across-jobs",
      "rows from two jobs and both key formats: newest per layer_cluster, no token",
      "none",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.several}`,
      { unordered: ["statements"] }
    ),
    get(
      "get/several-across-jobs-owner-token",
      "the same read with the owner's token",
      "owner",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.several}`,
      { unordered: ["statements"] }
    ),
    get(
      "get/unknown-report",
      "a report_id no report has",
      "none",
      "/api/v3/collectiveStatement?report_id=r1csrecunknown"
    ),
    get(
      "get/malformed-stored-row",
      "one stored row whose statement_data is not JSON",
      "none",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.malformed}`
    ),
    get(
      "get/statement-id",
      "one stored row by its key, no token",
      "none",
      `/api/v3/collectiveStatement?statement_id=${encodeURIComponent(
        F.storedStatements()[0].zid_topic_jobid
      )}`
    ),
    get(
      "get/statement-id-unknown",
      "a key no row has",
      "none",
      "/api/v3/collectiveStatement?statement_id=201%23unknown"
    ),
    get(
      "get/no-params",
      "neither report_id nor statement_id",
      "none",
      "/api/v3/collectiveStatement"
    ),
    get(
      "get/main-after-posts",
      "the main report after every POST above, no token",
      "none",
      `/api/v3/collectiveStatement?report_id=${R}`,
      { unordered: ["statements"] }
    ),

    // ------------------------------------------------------------------- reset
    get(
      "reset/before",
      "the reset target's statements before the reset",
      "none",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.reset}`,
      { unordered: ["statements"] }
    ),
    {
      id: "reset/delete-routine",
      about:
        "the FULL_PIPELINE reset's DynamoDB delete routine (delphi/umap_narrative/reset_conversation.py, delete_dynamodb_data) for the reset target",
      async run(ctx) {
        ctx.arm([]);
        ctx.note("reset", ctx.runReset(F.ZID.reset));
      },
    },
    get(
      "reset/after",
      "the reset target after the reset",
      "none",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.reset}`
    ),
    get(
      "reset/other-report-untouched",
      "another conversation's statements after the reset",
      "none",
      `/api/v3/collectiveStatement?report_id=${F.REPORT.several}`,
      { unordered: ["statements"] }
    ),
  ];
  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case ${c.id}`);
    ids.add(c.id);
  }
  return cases;
}

module.exports = { allCases };
