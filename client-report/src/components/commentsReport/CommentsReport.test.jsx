/**
 * P-003 S4 — the comments report must show a queued Delphi job, and must keep
 * showing the job it was actually handed.
 *
 * The component used to recognise only PROCESSING and kept the fact that a job
 * existed in component-local state, so a job sitting in PENDING — the normal
 * state while a worker starts up — looked to a reloading user like nothing had
 * happened. That is what made people submit the same report twice.
 *
 * Round-2 review added three more: the acknowledged job must not be swapped for
 * an unrelated running row (F5), a terminal root with live work under it must
 * keep polling (F5), and a batch submission must gain the same polling and
 * banner as a pipeline one (F6).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import net from '../../util/net';
import CommentsReport, {
  isTrackedJobLive,
  reconcileTrackedJob,
} from './CommentsReport.jsx';

jest.mock('../../util/net', () => ({
  __esModule: true,
  default: { polisGet: jest.fn(), polisPost: jest.fn() },
}));

// `mock`-prefixed so the jest.mock factory may close over it.
const mockReport = { id: 'r-test' };
jest.mock('../framework/useReportId', () => ({
  useReportId: () => ({ report_id: mockReport.id }),
}));

beforeEach(() => {
  mockReport.id = 'r-test';
});

jest.mock('../lists/commentList.jsx', () => () => <div />);

// The run-confirmation modal only offers "Run Analysis" to a token carrying the
// delphi_enabled claim; the namespace comes from the build-time env.
jest.mock('jwt-decode', () => ({
  jwtDecode: () => ({ [`${process.env.AUTH_NAMESPACE}delphi_enabled`]: true }),
}));

function mockEndpoints({ jobs = [], jobsByCall, withTopics = false } = {}) {
  let call = 0;
  net.polisGet.mockImplementation((path) => {
    if (path === '/api/v3/delphi/visualizations') {
      const next = jobsByCall ? jobsByCall[Math.min(call++, jobsByCall.length - 1)] : jobs;
      return Promise.resolve({ status: 'success', jobs: next });
    }
    if (path === '/api/v3/delphi/reports') {
      return Promise.resolve({ status: 'success', reports: {} });
    }
    if (path === '/api/v3/delphi/logs') {
      return Promise.resolve([]);
    }
    // /api/v3/delphi. Without `withTopics` there is no topic data yet, which
    // is the cold-start branch; with it, the full report branch renders and the
    // analysis controls are on screen.
    return Promise.resolve(
      withTopics
        ? { status: 'success', runs: { 'run-1': { topics: [] } } }
        : { status: 'success' }
    );
  });
}

const props = {
  math: {},
  comments: [],
  conversation: {},
  ptptCount: 0,
  formatTid: (tid) => `${tid}`,
  voteColors: {},
  reportModLevel: 0,
};

describe('CommentsReport Delphi job status', () => {
  it('renders a queued banner for a PENDING job', async () => {
    mockEndpoints({
      jobs: [{ jobId: 'job-pending', status: 'PENDING', visualizations: [] }],
    });

    render(<CommentsReport {...props} />);

    const banner = await screen.findByTestId('delphi-job-status');
    expect(banner).toHaveTextContent('Queued — waiting for a worker');
    expect(banner).toHaveTextContent('job-pending');
    expect(banner).not.toHaveTextContent('Processing');
  });

  it('renders processing only once a worker has claimed the job', async () => {
    mockEndpoints({
      jobs: [{ jobId: 'job-running', status: 'PROCESSING', visualizations: [] }],
    });

    render(<CommentsReport {...props} />);

    const banner = await screen.findByTestId('delphi-job-status');
    expect(banner).toHaveTextContent('Processing');
    expect(banner).not.toHaveTextContent('Queued');
  });

  it('shows no banner when every job is terminal', async () => {
    mockEndpoints({
      jobs: [
        { jobId: 'job-done', status: 'COMPLETED', visualizations: [] },
        { jobId: 'job-bad', status: 'FAILED', visualizations: [] },
      ],
    });

    render(<CommentsReport {...props} />);

    await waitFor(() => expect(net.polisGet).toHaveBeenCalled());
    expect(screen.queryByTestId('delphi-job-status')).toBeNull();
  });

  it('acknowledges a batch job submitted from this page', async () => {
    // F6: the batch acknowledgement used to set no tracked job at all, so a
    // batch submission gained neither a banner nor a polling loop.
    mockEndpoints({ jobs: [], withTopics: true });
    net.polisPost.mockResolvedValue({
      status: 'success',
      job_id: 'batch_report_r-test_9_zzzz',
      batch_id: 'batch_report_r-test_9_zzzz',
      job_status: 'PENDING',
      work_live: true,
      deduplicated: false,
    });

    render(<CommentsReport {...props} showControls authToken="synthetic-token" />);
    await waitFor(() => expect(net.polisGet).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole('button', { name: /Generate Batch Topics/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Run Analysis/ }));

    const banner = await screen.findByTestId('delphi-batch-job-status');
    expect(banner).toHaveTextContent('batch_report_r-test_9_zzzz');
    expect(banner).toHaveTextContent('Queued — waiting for a worker');
  });

  it('keeps polling a terminal root while a checker child is live', async () => {
    // F5: the root row is COMPLETED but the checker it spawned is not, so the
    // child becomes the tracked job rather than the banner disappearing.
    mockEndpoints({
      jobs: [
        { jobId: 'job-root', status: 'COMPLETED', visualizations: [] },
        { jobId: 'batch_check_job-root_1', status: 'PENDING', visualizations: [] },
      ],
    });

    render(<CommentsReport {...props} />);

    const banner = await screen.findByTestId('delphi-job-status');
    expect(banner).toHaveTextContent('batch_check_job-root_1');
  });

  it('renders a separate banner for an outstanding batch report job', async () => {
    // F6: batch jobs are excluded from the pipeline selector, so they need
    // their own tracked slot or they are never shown and never polled.
    mockEndpoints({
      jobs: [
        { jobId: 'batch_report_r-test_1_abcd', status: 'PENDING', visualizations: [] },
      ],
    });

    render(<CommentsReport {...props} />);

    const banner = await screen.findByTestId('delphi-batch-job-status');
    expect(banner).toHaveTextContent('Batch topics');
    expect(banner).toHaveTextContent('Queued — waiting for a worker');
    expect(screen.queryByTestId('delphi-job-status')).toBeNull();
  });

  it('keeps the queued banner and the run button disabled while a job is live', async () => {
    mockEndpoints({
      jobs: [{ jobId: 'job-pending', status: 'PENDING', visualizations: [] }],
    });

    render(<CommentsReport {...props} showControls />);

    await screen.findByTestId('delphi-job-status');
    for (const button of screen.getAllByRole('button', {
      name: /Run New Delphi Analysis/,
    })) {
      expect(button).toBeDisabled();
    }
  });
});

describe('report switching', () => {
  it('ignores a previous report\u2019s delayed response', async () => {
    // R5: the old render's callback compares two values it captured itself, so
    // without a generation reference it happily installs stale state.
    const resolvers = {};
    net.polisGet.mockImplementation((path, params) => {
      if (path === '/api/v3/delphi/visualizations') {
        return new Promise((resolve) => {
          resolvers[params.report_id] = resolve;
        });
      }
      if (path === '/api/v3/delphi/reports') {
        return Promise.resolve({ status: 'success', reports: {} });
      }
      if (path === '/api/v3/delphi/logs') {
        return Promise.resolve([]);
      }
      return Promise.resolve({ status: 'success' });
    });

    mockReport.id = 'r-old';
    const view = render(<CommentsReport {...props} />);
    await waitFor(() => expect(resolvers['r-old']).toBeDefined());

    // Switch reports before the first response lands.
    mockReport.id = 'r-new';
    view.rerender(<CommentsReport {...props} key="same" />);
    await waitFor(() => expect(resolvers['r-new']).toBeDefined());

    resolvers['r-new']({
      status: 'success',
      jobs: [{ jobId: 'new-report-job', status: 'PENDING', visualizations: [] }],
    });
    const banner = await screen.findByTestId('delphi-job-status');
    expect(banner).toHaveTextContent('new-report-job');

    // The old report's response arrives late and must be dropped.
    resolvers['r-old']({
      status: 'success',
      jobs: [{ jobId: 'old-report-job', status: 'PENDING', visualizations: [] }],
    });
    await waitFor(() =>
      expect(screen.getByTestId('delphi-job-status')).toHaveTextContent('new-report-job')
    );
    expect(screen.getByTestId('delphi-job-status')).not.toHaveTextContent('old-report-job');
  });
});

describe('reconcileTrackedJob', () => {
  const acknowledged = { jobId: 'job-a', status: 'PENDING', reportId: 'r-test' };

  it('never replaces the acknowledged job with another running row', () => {
    // F5, the defect: the old implementation picked the first active row in the
    // list, so an unrelated PROCESSING job B displaced acknowledged PENDING A.
    const next = reconcileTrackedJob(
      acknowledged,
      [
        { jobId: 'job-a', status: 'PENDING' },
        { jobId: 'job-b', status: 'PROCESSING' },
      ],
      false,
      'r-test'
    );
    expect(next.jobId).toBe('job-a');
  });

  it('keeps the acknowledged job when the list does not contain it yet', () => {
    const next = reconcileTrackedJob(
      acknowledged,
      [{ jobId: 'job-b', status: 'PROCESSING' }],
      false,
      'r-test'
    );
    expect(next).toBe(acknowledged);
  });

  it('follows its own durable status transition', () => {
    const next = reconcileTrackedJob(
      acknowledged,
      [{ jobId: 'job-a', status: 'PROCESSING' }],
      false,
      'r-test'
    );
    expect(next).toEqual({ jobId: 'job-a', status: 'PROCESSING', reportId: 'r-test' });
  });

  it('hands over to remaining work when the acknowledged job is terminal', () => {
    const next = reconcileTrackedJob(
      acknowledged,
      [
        { jobId: 'job-a', status: 'COMPLETED' },
        { jobId: 'batch_check_job-a_1', status: 'PENDING' },
      ],
      false,
      'r-test'
    );
    expect(next.jobId).toBe('batch_check_job-a_1');
  });

  it('clears when the acknowledged job is terminal and nothing else is live', () => {
    expect(
      reconcileTrackedJob(acknowledged, [{ jobId: 'job-a', status: 'COMPLETED' }], false, 'r-test')
    ).toBeNull();
  });

  it('keeps a terminal acknowledged job while the server says work is live', () => {
    // R4: a COMPLETED root whose checker has not surfaced in this
    // eventually-consistent list yet is not finished work.
    const live = { jobId: 'job-a', status: 'COMPLETED', workLive: true, reportId: 'r-test' };
    expect(
      reconcileTrackedJob(live, [{ jobId: 'job-a', status: 'COMPLETED' }], false, 'r-test')
    ).toBe(live);
  });

  it('does not treat an unknown status as terminal', () => {
    // R4: /delphi/visualizations reports "unknown" for a row with no status.
    const next = reconcileTrackedJob(
      { ...acknowledged, workLive: true },
      [{ jobId: 'job-a', status: 'unknown' }],
      false,
      'r-test'
    );
    expect(next).not.toBeNull();
    expect(next.jobId).toBe('job-a');
  });

  it('does not carry a job across a report change', () => {
    expect(reconcileTrackedJob(acknowledged, [], false, 'r-other')).toBeNull();
  });

  it('treats a terminal status with live work under it as still live', () => {
    expect(isTrackedJobLive({ jobId: 'x', status: 'COMPLETED' })).toBe(false);
    expect(isTrackedJobLive({ jobId: 'x', status: 'COMPLETED', workLive: true })).toBe(true);
  });
});
