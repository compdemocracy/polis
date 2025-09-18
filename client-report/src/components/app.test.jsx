import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './app';

// Silence noisy logs from route parsing during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Mock the useAuth hook from react-oidc-context
jest.mock('react-oidc-context', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
    user: null,
    signinRedirect: jest.fn(),
    signoutRedirect: jest.fn(),
    removeUser: jest.fn(),
  }),
}));

// Mock data for testing
const mockData = {
  conversation: {
    conversation_id: 123,
  },
  loading: false,
  errorText: null,
  nothingToShow: false,
};

jest.mock('./globals.js', () => ({
  brandColors: {
    agree: 'green',
    disagree: 'red',
    pass: 'yellow',
  },
  enableMatrix: true,
}));

test('renders nothing to show message if there is no data', async () => {
  render(<App {...mockData} nothingToShow={true} />);
  
  // Wait for the component to finish loading and rendering
  await waitFor(() => {
    const nothingToShowText = screen.getByText(/Nothing to show yet/);
    expect(nothingToShowText).toBeInTheDocument();
  });
});