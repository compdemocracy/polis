import React from 'react';
import { render, waitFor } from '@testing-library/react';

// The narrative fetch must send no credentials: the report uses no cookies, and
// a credentialed request is refused by the browser when the API answers
// `Access-Control-Allow-Origin: *` to a cross-origin caller.

const mockUser = { access_token: 'test-token' };
jest.mock('react-oidc-context', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: mockUser,
    signinRedirect: jest.fn(),
    signoutRedirect: jest.fn(),
    removeUser: jest.fn(),
  }),
}));

jest.mock('../util/net.js', () => ({
  __esModule: true,
  default: { polisGet: jest.fn(() => Promise.resolve([])), polisPost: jest.fn(() => Promise.resolve({})) },
}));

jest.mock('./globals.js', () => ({
  brandColors: { agree: 'green', disagree: 'red', pass: 'yellow' },
}));

describe('narrative fetch', () => {
  const originalClientId = process.env.AUTH_CLIENT_ID;

  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AUTH_CLIENT_ID = 'test-client';
    window.history.pushState({}, '', '/narrativeReport/r1abc');
  });

  afterAll(() => {
    if (originalClientId === undefined) delete process.env.AUTH_CLIENT_ID;
    else process.env.AUTH_CLIENT_ID = originalClientId;
    jest.restoreAllMocks();
  });

  test('passes credentials "omit"', async () => {
    const net = require('../util/net.js').default;
    net.polisGet.mockImplementation((path) =>
      path === '/api/v3/reports'
        ? Promise.resolve([{ report_id: 'r1abc', conversation_id: 'c1' }])
        : Promise.resolve({})
    );
    fetch.mockResponse('');
    const App = require('./app').default;
    render(<App />);

    await waitFor(() => {
      expect(
        fetch.mock.calls.some(([url]) => String(url).includes('api/v3/reportNarrative'))
      ).toBe(true);
    });
    const [, options] = fetch.mock.calls.find(([url]) =>
      String(url).includes('api/v3/reportNarrative')
    );
    expect(options.credentials).toBe('omit');
  });
});
