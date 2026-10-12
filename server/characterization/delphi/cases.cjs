"use strict";
// The recorded case list, derived from fixtures/manifest.json. Every Delphi
// read route of the consumer map (cost-reduction map 4, section 1) in each of
// the nine states, plus the request variants the readers branch on. The order
// is the replay order; ids are stable file names under recordings/.
const path = require("node:path");
const manifest = require(path.join(__dirname, "fixtures", "manifest.json"));

const STATE_ORDER = [
  "not_run",
  "pending",
  "running",
  "failed",
  "completed",
  "two_models",
  "rerun_after_votes",
  "truncated_narrative",
  "zero_vote",
];

const q = encodeURIComponent;

function stateCases(s) {
  const m = manifest.states[s];
  const R = m.report_id;
  const C = m.conversation_id;
  const jobs = m.jobs;
  const checkers = Object.keys(jobs)
    .filter((k) => k.startsWith("checker"))
    .map((k) => jobs[k]);
  const pipelines = Object.keys(jobs)
    .filter((k) => k.startsWith("pipeline"))
    .map((k) => jobs[k]);
  const out = [];
  const add = (slug, route, p, auth = "none") =>
    out.push({ id: `${s}/${slug}`, state: s, route, path: p, auth });

  add("delphi", "GET /api/v3/delphi", `/api/v3/delphi?report_id=${R}`);

  add(
    "delphi-reports",
    "GET /api/v3/delphi/reports",
    `/api/v3/delphi/reports?report_id=${R}`
  );
  for (const c of checkers)
    add(
      `delphi-reports/job-${c}`,
      "GET /api/v3/delphi/reports",
      `/api/v3/delphi/reports?report_id=${R}&job_id=${q(c)}`
    );
  add(
    "delphi-reports/job-unknown",
    "GET /api/v3/delphi/reports",
    `/api/v3/delphi/reports?report_id=${R}&job_id=generated-unknown-job`
  );
  const withSections = checkers.filter((c) => m.sections[c]);
  const sections = withSections.length
    ? m.sections[withSections[withSections.length - 1]]
    : [];
  if (sections.length) {
    add(
      "delphi-reports/section-exact",
      "GET /api/v3/delphi/reports",
      `/api/v3/delphi/reports?report_id=${R}&section=${q(sections[0])}`
    );
    add(
      "delphi-reports/section-topic-key-model",
      "GET /api/v3/delphi/reports",
      `/api/v3/delphi/reports?report_id=${R}&section=${q(
        sections[0]
      )}&topic_key=model`
    );
  }
  add(
    "delphi-reports/section-fuzzy",
    "GET /api/v3/delphi/reports",
    `/api/v3/delphi/reports?report_id=${R}&section=global_uncertainty`
  );
  add(
    "delphi-reports/section-topic-key-missing",
    "GET /api/v3/delphi/reports",
    `/api/v3/delphi/reports?report_id=${R}&section=global_groups&topic_key=generated-missing`
  );

  add(
    "delphi-visualizations",
    "GET /api/v3/delphi/visualizations",
    `/api/v3/delphi/visualizations?report_id=${R}`
  );
  for (const j of pipelines)
    add(
      `delphi-visualizations/job-${j}`,
      "GET /api/v3/delphi/visualizations",
      `/api/v3/delphi/visualizations?report_id=${R}&job_id=${j}`
    );

  for (const j of Object.values(jobs))
    add(
      `delphi-logs/${j}`,
      "GET /api/v3/delphi/logs",
      `/api/v3/delphi/logs?job_id=${q(j)}`,
      "owner"
    );

  add(
    "topicStats",
    "GET /api/v3/topicStats",
    `/api/v3/topicStats?report_id=${R}`
  );

  add(
    "collectiveStatement",
    "GET /api/v3/collectiveStatement",
    `/api/v3/collectiveStatement?report_id=${R}`
  );
  m.statements.forEach((st, i) =>
    add(
      `collectiveStatement/statement-${i}`,
      "GET /api/v3/collectiveStatement",
      `/api/v3/collectiveStatement?statement_id=${q(st)}`
    )
  );

  add(
    "topicPrioritize",
    "GET /api/v3/participation/topicPrioritize",
    `/api/v3/participation/topicPrioritize?conversation_id=${C}`
  );
  add(
    "topicAgenda-selections/anonymous",
    "GET /api/v3/topicAgenda/selections",
    `/api/v3/topicAgenda/selections?conversation_id=${C}`
  );
  for (const pid of m.selections)
    add(
      `topicAgenda-selections/pid-${pid}`,
      "GET /api/v3/topicAgenda/selections",
      `/api/v3/topicAgenda/selections?conversation_id=${C}`,
      `participant:${pid}`
    );

  add(
    "reportExport-comment-clusters",
    "GET /api/v3/reportExport/:report_id/:report_type",
    `/api/v3/reportExport/${R}/comment-clusters.csv`
  );

  add("feeds", "GET /feeds/:reportId", `/feeds/${R}`);
  add(
    "feeds-consensus",
    "GET /feeds/:reportId/consensus",
    `/feeds/${R}/consensus`
  );
  add("feeds-topics", "GET /feeds/:reportId/topics", `/feeds/${R}/topics`);

  add(
    "topicMod-topics",
    "GET /api/v3/topicMod/topics",
    `/api/v3/topicMod/topics?conversation_id=${C}`
  );
  // One case per pipeline job: in the rerun state that is the current job and
  // the reset-wiped older one (the latter records the empty answer as a control).
  for (const j of pipelines)
    add(
      `topicMod-topics/job-${j}`,
      "GET /api/v3/topicMod/topics",
      `/api/v3/topicMod/topics?conversation_id=${C}&job_id=${j}`
    );
  add(
    "topicMod-proximity",
    "GET /api/v3/topicMod/proximity",
    `/api/v3/topicMod/proximity?conversation_id=${C}`
  );
  add(
    "topicMod-hierarchy",
    "GET /api/v3/topicMod/hierarchy",
    `/api/v3/topicMod/hierarchy?conversation_id=${C}`
  );
  add(
    "topicMod-stats",
    "GET /api/v3/topicMod/stats",
    `/api/v3/topicMod/stats?conversation_id=${C}`
  );
  if (m.topic_keys.length)
    add(
      "topicMod-topic-comments",
      "GET /api/v3/topicMod/topics/:topicKey/comments",
      `/api/v3/topicMod/topics/${q(
        m.topic_keys[0]
      )}/comments?conversation_id=${C}`
    );

  // The topical next-comment path (TOPICAL_COMMENT_RATIO pinned to 1,
  // Math.random reseeded per case): topic agenda selections -> topic names ->
  // cached assignments -> one comment.
  for (const pid of [...new Set([1, ...m.selections])])
    add(
      `nextComment/pid-${pid}`,
      "GET /api/v3/nextComment",
      `/api/v3/nextComment?conversation_id=${C}`,
      `participant:${pid}`
    );
  if (s === "completed") {
    add(
      "nextComment/pid-3-without-topical-pool",
      "GET /api/v3/nextComment",
      `/api/v3/nextComment?conversation_id=${C}&without=2`,
      "participant:3"
    );
    add(
      "nextComment/anonymous",
      "GET /api/v3/nextComment",
      `/api/v3/nextComment?conversation_id=${C}`
    );
  }

  return out;
}

function globalCases() {
  const done = manifest.states.completed;
  const add = (slug, route, p, auth = "none") => ({
    id: `boundary/${slug}`,
    state: "boundary",
    route,
    path: p,
    auth,
  });
  return [
    add("delphi-missing-report", "GET /api/v3/delphi", "/api/v3/delphi"),
    add(
      "delphi-unknown-report",
      "GET /api/v3/delphi",
      "/api/v3/delphi?report_id=r2p2zerounknown"
    ),
    add(
      "delphi-reports-unknown-report",
      "GET /api/v3/delphi/reports",
      "/api/v3/delphi/reports?report_id=r2p2zerounknown"
    ),
    add(
      "delphi-visualizations-unknown-report",
      "GET /api/v3/delphi/visualizations",
      "/api/v3/delphi/visualizations?report_id=r2p2zerounknown"
    ),
    add(
      "delphi-logs-no-token",
      "GET /api/v3/delphi/logs",
      `/api/v3/delphi/logs?job_id=${done.jobs.pipeline1}`
    ),
    add(
      "delphi-logs-not-moderator",
      "GET /api/v3/delphi/logs",
      `/api/v3/delphi/logs?job_id=${done.jobs.pipeline1}`,
      "other"
    ),
    add(
      "delphi-logs-unknown-job",
      "GET /api/v3/delphi/logs",
      "/api/v3/delphi/logs?job_id=generated-unknown-job",
      "owner"
    ),
    add(
      "topicStats-unknown-report",
      "GET /api/v3/topicStats",
      "/api/v3/topicStats?report_id=r2p2zerounknown"
    ),
    add(
      "collectiveStatement-unknown-statement",
      "GET /api/v3/collectiveStatement",
      "/api/v3/collectiveStatement?statement_id=generated-unknown"
    ),
    add(
      "collectiveStatement-no-params",
      "GET /api/v3/collectiveStatement",
      "/api/v3/collectiveStatement"
    ),
    add(
      "feeds-unknown-report",
      "GET /feeds/:reportId",
      "/feeds/r2p2zerounknown"
    ),
  ];
}

function allCases() {
  const cases = [...globalCases()];
  for (const s of STATE_ORDER) cases.push(...stateCases(s));
  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    ids.add(c.id);
  }
  return cases;
}

module.exports = { allCases, STATE_ORDER, manifest };
