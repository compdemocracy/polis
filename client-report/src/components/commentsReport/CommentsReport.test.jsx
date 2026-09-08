/**
 * P-003 S4 — the comments report must show a queued Delphi job.
 *
 * The component used to recognise only PROCESSING and kept the fact that a job
 * existed in component-local state, so a job sitting in PENDING — the normal
 * state while a worker starts up — looked to a reloading user like nothing had
 * happened. That is what made people submit the same report twice.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import net from '../../util/net';
import CommentsReport from './CommentsReport.jsx';

jest.mock('../../util/net', () => ({
  __esModule: true,
  default: { polisGet: jest.fn(), polisPost: jest.fn() },
}));

jest.mock('../framework/useReportId', () => ({
  useReportId: () => ({ report_id: 'r-test' }),
}));

jest.mock('../lists/commentList.jsx', () => () => <div />);

function mockEndpoints({ jobs = [] } = {}) {
  net.polisGet.mockImplementation((path) => {
    if (path === '/api/v3/delphi/visualizations') {
      return Promise.resolve({ status: 'success', jobs });
    }
    if (path === '/api/v3/delphi/reports') {
      return Promise.resolve({ status: 'success', reports: {} });
    }
    if (path === '/api/v3/delphi/logs') {
      return Promise.resolve([]);
    }
    // /api/v3/delphi: no topic data yet, which is the cold-start case.
    return Promise.resolve({ status: 'success' });
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

  it('ignores a queued batch report job in the pipeline banner', async () => {
    mockEndpoints({
      jobs: [
        { jobId: 'batch_report_r-test_1_abcd', status: 'PENDING', visualizations: [] },
      ],
    });

    render(<CommentsReport {...props} />);

    await waitFor(() => expect(net.polisGet).toHaveBeenCalled());
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
