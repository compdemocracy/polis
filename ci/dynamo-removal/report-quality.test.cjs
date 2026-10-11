const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertReportCoverage } = require('./report-quality.cjs');
const coverageFixture = () => {
  const runs = { current: { topics_by_layer: { 0: {
    0: { topic_key: 'generated#0#0' }, 1: { topic_key: 'generated#0#1' }
  } } } };
  const sections = ['generated_0_0', 'generated_0_1', 'generated_global_groups',
    'generated_global_group_informed_consensus', 'generated_global_uncertainty'];
  return { runs, reports: Object.fromEntries(sections.map(section => [section, { section, job_id: 'generated' }])) };
};
test('requires all topic and global sections from one served job', () => {
  const { reports, runs } = coverageFixture();
  assert.equal(assertReportCoverage(reports, runs), 5);
});
test('rejects a missing topic or global even when remaining reports are valid', () => {
  for (const missing of ['generated_0_1', 'generated_global_uncertainty']) {
    const { reports, runs } = coverageFixture(); delete reports[missing];
    assert.throws(() => assertReportCoverage(reports, runs), /complete topic and global/);
  }
});
test('rejects duplicate topic keys or duplicate report identities', () => {
  const { reports, runs } = coverageFixture();
  runs.current.topics_by_layer[0][1].topic_key = 'generated#0#0';
  assert.throws(() => assertReportCoverage(reports, runs), /duplicate topic/);
  const fresh = coverageFixture();
  fresh.reports.generated_0_1.section = 'generated_0_0';
  assert.throws(() => assertReportCoverage(fresh.reports, fresh.runs), /duplicate or mismatched/);
});
test('rejects reports from a different job', () => {
  const { reports, runs } = coverageFixture(); reports.generated_0_0.job_id = 'other-job';
  assert.throws(() => assertReportCoverage(reports, runs), /served narrative job/);
});
