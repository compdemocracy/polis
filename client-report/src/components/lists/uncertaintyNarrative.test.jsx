import React from 'react';
import { render, screen } from '@testing-library/react';
import UncertaintyNarrative from './uncertaintyNarrative';
import * as globals from '../globals.js'; // Mock globals if necessary
jest.mock('../narrative/index.jsx', () => ({ model }) => <div data-testid={`mock-narrative-${model}`} /> ); // Mock Narrative
jest.mock('./commentList.jsx', () => () => <div data-testid="mock-comment-list" />);
import '@testing-library/jest-dom';

describe('UncertaintyNarrative Component', () => {
  const mockProps = {
    conversation: {},
    comments: {},
    ptptCount: 100,
    formatTid: jest.fn((tid) => `TID${tid}`),
    math: {},
    voteColors: {},
    narrative: {
        responseClaude: { content: [{ text: '"paragraphs":[{"sentences":[{"clauses":[{"citations":["T1","T2"]}]}]}]}' }] },
        responseGemini: '{"paragraphs":[{"sentences":[{"clauses":[{"citations":["T3"]}]}]}]}'
    },
    model: 'claude'
  };

  it('renders loading message when data is missing', () => {
    render(<UncertaintyNarrative conversation={null} />);
    expect(screen.getByText('Loading Uncertainty...')).toBeInTheDocument();
  });

  it('renders component with narrative and comment list when data is present (Claude model)', () => {
    render(<UncertaintyNarrative {...mockProps} />);

    expect(screen.getByText('Uncertainty Narrative')).toBeInTheDocument();
    expect(screen.getByText('This narrative summary may contain hallucinations. Check each clause.')).toBeInTheDocument();
    expect(screen.getByTestId('mock-narrative-claude')).toBeInTheDocument();
    expect(screen.getByTestId('mock-comment-list')).toBeInTheDocument();
  });

  it('renders component with narrative and comment list when data is present (Gemini model)', () => {
    render(<UncertaintyNarrative {...mockProps} model="gemini" />);

    expect(screen.getByText('Uncertainty Narrative')).toBeInTheDocument();
    expect(screen.getByText('This narrative summary may contain hallucinations. Check each clause.')).toBeInTheDocument();
    expect(screen.getByTestId('mock-narrative-gemini')).toBeInTheDocument();
    expect(screen.getByTestId('mock-comment-list')).toBeInTheDocument();
  });

});