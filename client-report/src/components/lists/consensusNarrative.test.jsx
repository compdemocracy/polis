import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConsensusNarrative from './consensusNarrative';
import * as globals from '../globals.js';
import Narrative from '../narrative/index.jsx';
import CommentList from './commentList.jsx';

jest.mock('../narrative/index.jsx', () => {
  return ({ sectionData, model }) => (
    <div data-testid="mock-narrative">
      Narrative Component - Model: {model} - Data: {JSON.stringify(sectionData)}
    </div>
  );
});

jest.mock('./commentList.jsx', () => {
  return ({ conversation, ptptCount, math, formatTid, tidsToRender, comments, voteColors }) => (
    <div data-testid="mock-comment-list">
      CommentList Component - TIDs: {JSON.stringify(tidsToRender)}
    </div>
  );
});

describe('ConsensusNarrative Component', () => {
    const mockNarrativeData = {modelResponse: `{"paragraphs":[{"sentences":[{"clauses":[{"citations":["tid2","tid3","tid1"]}]}]}]}`};
      

  const mockProps = {
    math: {},
    comments: [],
    conversation: {},
    ptptCount: 5,
    formatTid: jest.fn((tid) => `Formatted ${tid}`),
    voteColors: {},
    narrative: mockNarrativeData,
    model: "claude",
  };


  it('renders the component', async () => {
    render(<ConsensusNarrative {...mockProps} />);

    expect(screen.getByText('Consensus Across Groups')).toBeInTheDocument();
    expect(screen.getByText('This narrative summary may contain hallucinations. Check each clause.')).toBeInTheDocument();

    expect(screen.getByTestId('mock-comment-list')).toHaveTextContent('CommentList Component - TIDs: ["tid2","tid3","tid1"]');
  });
});