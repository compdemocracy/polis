import React from 'react';
import { render, fireEvent } from '@testing-library/react';
// Mock d3 functions used in the component (if necessary)
Object.defineProperty(window, 'd3', {
  writable: true,
});

global.window.d3 = {
  scaleLinear: jest.fn().mockReturnValue({
    rangeRound: jest.fn().mockReturnValue({
      domain: jest.fn()
    }),
    domain: jest.fn()
  }),
  extent: jest.fn(() => [0, 1]),
  forceSimulation: jest.fn().mockReturnValue({
    force: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    tick: jest.fn()
  }),
  forceX: jest.fn().mockReturnValue({  // Add a mock return for forceX
    strength: jest.fn().mockReturnThis() // Add a mock for strength
  }),
  forceY: jest.fn(),
  forceCollide: jest.fn(),
  voronoi: jest.fn().mockReturnValue({
    extent: jest.fn().mockReturnThis(),
    x: jest.fn().mockReturnThis(),
    y: jest.fn().mockReturnThis(),
    polygons: jest.fn().mockReturnValue([
      {
        join: jest.fn(),
        data: {}
      },
    ])
  })
}
import Beeswarm from './beeswarm';
import * as d3 from 'd3';


describe('Beeswarm Component', () => {
  const mockComments = [
    { tid: 1, text: 'Comment 1' },
    { tid: 2, text: 'Comment 2' },
    { tid: 3, text: 'Comment 3' }
  ];
  const mockExtremity = { 1: 0.2, 2: 0.8, 3: 0.5 };
  const mockProbabilitiesTids = { 1: [0.1, 0.2, 0.3] };
  const mockProbabilities = {
    1: [0.1, 0.2, 0.3],
    2: [0.4, 0.5, 0.6],
    3: [0.7, 0.8, 0.9]
  };
  const mockConversation = { id: 1, title: 'Test Conversation' };
  const mockPtptCount = 100;
  const mockMath = {}; // Replace with actual math object if needed
  const mockFormatTid = (tid) => `TID-${tid}`;
  const mockVoteColors = { agree: 'green', disagree: 'red' };

  it('renders without crashing', () => {
    render(
      <Beeswarm
        comments={mockComments}
        extremity={mockExtremity}
        probabilitiesTids={mockProbabilitiesTids}
        probabilities={mockProbabilities}
        conversation={mockConversation}
        ptptCount={mockPtptCount}
        math={mockMath}
        formatTid={mockFormatTid}
        voteColors={mockVoteColors}
      />
    );
  });
});