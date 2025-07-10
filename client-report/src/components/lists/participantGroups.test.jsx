import React from 'react';
import { render, screen } from '@testing-library/react';
import ParticipantGroups from './participantGroups';
import * as globals from '../globals'; // Mock globals if necessary
import Metadata from './metadata.jsx'; // Mock Metadata
import Group from './participantGroup.jsx'; // Mock Group
import '@testing-library/jest-dom';

jest.mock('../globals', () => ({
  primaryHeading: { fontSize: '20px' },
  paragraph: { fontSize: '16px' },
}));

jest.mock('./metadata.jsx', () => () => <div data-testid="mock-metadata" />);
jest.mock('./participantGroup.jsx', () => ({ groupName }) => (
  <div data-testid={`mock-group-${groupName}`}>{groupName}</div>
));

describe('ParticipantGroups Component', () => {
  const mockProps = {
    conversation: {},
    ptptCount: 100,
    math: {
      "group-votes": {
        0: { "n-members": 20, votes: { 1: { A: 10, D: 5, S: 5 }, 2: { A: 15, D: 0, S: 5 } } },
        1: { "n-members": 30, votes: { 1: { A: 5, D: 15, S: 10 }, 3: { A: 20, D: 5, S: 5 } } },
      },
      repness: {
        0: { someData: 'group0data' },
        1: { someData: 'group1data' },
      },
    },
    comments: {},
    voteColors: {},
    formatTid: jest.fn((tid) => `TID${tid}`),
    groupNames: {
        0: "Group A",
        1: "Group B"
    },
    badTids: [],
    repfulAgreeTidsByGroup: {},
    repfulDisageeTidsByGroup: {},
    report: {},
    style: { backgroundColor: 'lightgray' }
  };

  it('renders loading message when data is missing', () => {
    render(<ParticipantGroups />);
    expect(screen.getByText('Loading Groups')).toBeInTheDocument();
  });

  it('renders component with groups when data is present', () => {
    render(<ParticipantGroups {...mockProps} />);

    expect(screen.getByText('Opinion Groups')).toBeInTheDocument();
    expect(screen.getByText(/Across 100 total participants, 2 opinion groups emerged/)).toBeInTheDocument();
    expect(screen.getByTestId('mock-metadata')).toBeInTheDocument();
    expect(screen.getByTestId('mock-group-Group A')).toBeInTheDocument();
    expect(screen.getByTestId('mock-group-Group B')).toBeInTheDocument();
  });

    it("renders correct number of groups", () => {
        render(<ParticipantGroups {...mockProps} />);
        expect(screen.getAllByTestId(/mock-group-/).length).toBe(2);
    })
});