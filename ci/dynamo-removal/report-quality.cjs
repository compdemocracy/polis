const assert = require('node:assert/strict');

function assertReportCoverage(reports, runs) {
  const topics = Object.values(runs || {}).flatMap(run => Object.values(run.topics_by_layer || {}).flatMap(Object.values));
  assert(topics.length > 0, 'topic coverage requires served topics');
  const expected = topics.map(topic => {
    assert(/^.+#\d+#\d+$/.test(topic.topic_key), 'valid topic key required');
    return topic.topic_key.replaceAll('#', '_');
  });
  assert.equal(new Set(expected).size, expected.length, 'duplicate topic section');
  const jobs = new Set(topics.map(topic => topic.topic_key.split('#')[0]));
  assert.equal(jobs.size, 1, 'one coherent served narrative job required');
  const [job] = jobs;
  expected.push(...['groups', 'group_informed_consensus', 'uncertainty'].map(name => `${job}_global_${name}`));
  const actual = Object.entries(reports || {}).map(([key, report]) => {
    assert.equal(report.section, key, 'duplicate or mismatched report section');
    assert.equal(report.job_id, job, 'report belongs to served narrative job');
    return key;
  });
  assert.deepEqual(actual.sort(), expected.sort(), 'complete topic and global section coverage');
  return expected.length;
}

function assertFixtureReports(reports) {
  assert(reports && Object.keys(reports).length > 0, 'served reports required');
  const checked = {};
  for (const [section, stored] of Object.entries(reports)) {
    const document = typeof stored.report_data === 'string' ? JSON.parse(stored.report_data) : stored.report_data;
    assert.equal(stored.model, 'local-narrative-fixture/1');
    assert.equal(stored.metadata?.provider_fixture, true);
    assert.equal(document.provider_fixture, true);
    const clauses = document.paragraphs.flatMap(p => p.sentences.flatMap(s => s.clauses.map(c => c.text)));
    assert.deepEqual(clauses, ['Fixed narrative stand-in for queue, Postgres storage and report rendering proof. No LLM provider was called.']);
    checked[section] = { document, clauses };
  }
  return checked;
}
module.exports = { assertFixtureReports, assertReportCoverage };
