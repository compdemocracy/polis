import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './app';

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

test('renders nothing to show message if there is no data', () => {
  render(<App {...mockData} nothingToShow={true} />);
  const nothingToShowText = screen.getByText(/Nothing to show yet/);
  expect(nothingToShowText).toBeInTheDocument();
});