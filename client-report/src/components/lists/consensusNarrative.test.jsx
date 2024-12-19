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
    const mockNarrativeData = {
          responseClaude: {
            content: [{ text: '"paragraphs":[{"sentences":[{"clauses":[{"citations":["tid1","tid2"]}]}]}]}' }],
          },
          responseGemini: '{"paragraphs":[{"sentences":[{"clauses":[{"citations":["tid2","tid3","tid1"]}]}]}]}',
      };
      

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

  it('renders loading message when narrative data is missing', () => {
    render(<ConsensusNarrative />);
    expect(screen.getByText('Loading Consensus...')).toBeInTheDocument();
  });

  it('renders the component with Claude model', async () => {
    render(<ConsensusNarrative {...mockProps} />);

    expect(screen.getByText('Group Aware Consensus Narrative')).toBeInTheDocument();
    expect(screen.getByText('This narrative summary may contain hallucinations. Check each clause.')).toBeInTheDocument();

    expect(screen.getByTestId('mock-narrative')).toHaveTextContent('Model: claude');
    expect(screen.getByTestId('mock-comment-list')).toHaveTextContent('TIDs: ["tid1","tid2"]');
  });

    it('renders the component with Gemini model', async () => {
        render(<ConsensusNarrative {...{...mockProps, model: "gemini"}} />);

        expect(screen.getByText('Group Aware Consensus Narrative')).toBeInTheDocument();
        expect(screen.getByText('This narrative summary may contain hallucinations. Check each clause.')).toBeInTheDocument();

        expect(screen.getByTestId('mock-narrative')).toHaveTextContent('Model: gemini');
        expect(screen.getByTestId('mock-comment-list')).toHaveTextContent('TIDs: ["tid2","tid3","tid1"]');
    });
});