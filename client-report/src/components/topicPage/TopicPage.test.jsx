import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import TopicPage from './TopicPage';
import net from '../../util/net';

jest.mock('../../util/net', () => ({ polisGet: jest.fn(), polisPost: jest.fn() }));
jest.mock('../framework/heading.jsx', () => () => null);
jest.mock('../framework/Footer.jsx', () => () => null);
jest.mock('../topicStats/visualizations/TopicBeeswarm.jsx', () => () => null);
jest.mock('../topicStats/visualizations/AllCommentsScatterplot.jsx', () => () => null);
jest.mock('../lists/commentList.jsx', () => () => null);

const key = 'job#0#1';
// Every group agrees with every comment: the old page would have generated.
const math = {
  'group-consensus-normalized': { 0: 1, 1: 1, 2: 1 },
  'group-votes': { 0: { 'n-members': 10, votes: { 0: { A: 9, D: 0, S: 10 }, 1: { A: 9, D: 0, S: 10 }, 2: { A: 9, D: 0, S: 10 } } } },
};
const props = { conversation: {}, report_id: 'demo', topic_key: key, math, comments: [], formatTid: String, voteColors: {}, ptptCount: 0, token: 'generated-token' };
const doc = { paragraphs: [{ id: 'p', title: 'Shared priorities', sentences: [{ clauses: [{ text: 'We support this cited proposal.', citations: [0] }] }] }] };
const unpublished = 'No candidate collective statement has been published for this topic yet.';

function other(path) {
  if (path === '/api/v3/delphi') return { status: 'success', runs: { latest: { topics_by_layer: { 0: { 1: { topic_key: key, topic_name: 'Test topic' } } } } } };
  if (path === '/api/v3/topicStats') return { status: 'success', stats: { [key]: { comment_tids: [0, 1, 2] } } };
  return { status: 'success', reports: {} };
}
const stored = statements => async path => (path === '/api/v3/collectiveStatement' ? { status: 'success', statements } : other(path));

beforeEach(() => {
  jest.clearAllMocks();
  net.polisGet.mockImplementation(stored([]));
});

test('an eligible topic with no stored statement says so and never requests generation', async () => {
  render(<TopicPage {...props} />);
  await screen.findByText(unpublished);
  expect(net.polisPost).not.toHaveBeenCalled();
});

test('a stored agent statement renders as Imported with its exact model', async () => {
  net.polisGet.mockImplementation(stored([
    { topic_key: key, statement_data: doc, created_at: '2026-10-08T00:00:00Z', model: 'external-writer', provenance: 'external agent' },
  ]));
  render(<TopicPage {...props} />);
  await screen.findByText('We support this cited proposal.');
  expect(screen.getByText(/Imported/)).toHaveTextContent('external-writer');
  expect(net.polisPost).not.toHaveBeenCalled();
});

test('the newest stored version is shown; a server-generated one keeps its exact model', async () => {
  net.polisGet.mockImplementation(stored([
    { topic_key: key, statement_data: { paragraphs: [{ sentences: [{ clauses: [{ text: 'Older version.', citations: [0] }] }] }] }, created_at: '2026-10-01T00:00:00Z', model: 'external-writer', provenance: 'external agent' },
    { topic_key: key, statement_data: doc, created_at: '2026-10-09T00:00:00Z', model: 'claude-opus-4-8' },
    { topic_key: 'job#0#2', statement_data: doc, created_at: '2026-10-10T00:00:00Z', model: 'elsewhere' },
  ]));
  render(<TopicPage {...props} />);
  await screen.findByText('We support this cited proposal.');
  expect(screen.queryByText('Older version.')).toBeNull();
  expect(screen.getByText(/Generated/)).toHaveTextContent('claude-opus-4-8');
  expect(net.polisPost).not.toHaveBeenCalled();
});

test('a read failure is reported as such, not as unpublished, and not followed by generation', async () => {
  net.polisGet.mockImplementation(async path => {
    if (path === '/api/v3/collectiveStatement') throw Error('offline');
    return other(path);
  });
  render(<TopicPage {...props} />);
  await screen.findByText('Unable to load the stored candidate collective statement. Please try again later.');
  expect(screen.queryByText(unpublished)).toBeNull();
  expect(net.polisPost).not.toHaveBeenCalled();
});

test('a late answer for the previous report cannot replace the current one', async () => {
  let resolve;
  net.polisGet.mockImplementation((path, q) => (path === '/api/v3/collectiveStatement' && q.report_id === 'demo'
    ? new Promise(r => { resolve = r; })
    : Promise.resolve(path === '/api/v3/collectiveStatement' ? { status: 'success', statements: [] } : other(path))));
  const view = render(<TopicPage {...props} />);
  await waitFor(() => expect(resolve).toBeDefined());
  view.rerender(<TopicPage {...props} report_id="next" />);
  await screen.findByText(unpublished);
  await act(async () => resolve({ status: 'success', statements: [{ topic_key: key, statement_data: doc, created_at: '2026-10-08T00:00:00Z' }] }));
  expect(screen.queryByText('We support this cited proposal.')).toBeNull();
  expect(net.polisPost).not.toHaveBeenCalled();
});


test.each([
  ['job#0#1', 'job_0_1', false],
  ['another-job#12#34', 'another-job_12_34', true],
  ['layer0_1', 'layer0_1', false],
])('loads the stored narrative for topic %s', async (topicKey, section, encoded) => {
  const narrative = { paragraphs: [{ sentences: [{ clauses: [{ text: 'A stored topic narrative.', citations: [] }] }] }] };
  net.polisGet.mockImplementation(async (path, query) => {
    if (path === '/api/v3/delphi/reports') {
      return {
        status: 'success',
        reports: query.section === section
          ? { [section]: { section, report_data: encoded ? JSON.stringify(narrative) : narrative } }
          : {},
      };
    }
    if (path === '/api/v3/delphi') return {
      status: 'success', runs: { latest: { topics_by_layer: {
        0: { 1: { topic_key: topicKey, topic_name: 'Test topic' } },
      } } },
    };
    if (path === '/api/v3/topicStats') return {
      status: 'success', stats: { [topicKey]: { comment_tids: [] } },
    };
    return stored([])(path);
  });
  render(<TopicPage {...props} topic_key={topicKey} />);
  await screen.findByText('A stored topic narrative.');
  expect(net.polisGet).toHaveBeenCalledWith('/api/v3/delphi/reports', {
    report_id: props.report_id,
    section,
  });
  expect(net.polisPost).not.toHaveBeenCalled();
});

test('a narrative stored for another cluster whose name contains this one is not shown', async () => {
  const sibling = { paragraphs: [{ sentences: [{ clauses: [{ text: 'Cluster twelve narrative.', citations: [] }] }] }] };
  net.polisGet.mockImplementation(async (path, query) => {
    // The server answers job_0_1 with job_0_12 when job_0_1 is not stored.
    if (path === '/api/v3/delphi/reports') return {
      status: 'success', reports: { [query.section]: { section: 'job_0_12', report_data: sibling } },
    };
    return stored([])(path);
  });
  render(<TopicPage {...props} />);
  await screen.findByText(unpublished);
  await waitFor(() => expect(net.polisGet).toHaveBeenCalledWith('/api/v3/delphi/reports', {
    report_id: props.report_id,
    section: 'job_0_1',
  }));
  await act(async () => {});
  expect(screen.queryByText('Cluster twelve narrative.')).toBeNull();
});
