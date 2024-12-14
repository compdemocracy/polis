import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ParticipantsGraph from './participantsGraph';
import '@testing-library/jest-dom';
import * as d3contour from "d3-contour";
import * as d3chromatic from "d3-scale-chromatic";
import * as d3geo from "d3-geo";

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
  scaleSequential: jest.fn(() => ({
    domain: jest.fn(() => jest.fn()), // Mock domain function
  })),
  geoPath: jest.fn(() => jest.fn()),
  extent: jest.fn(() => [0, 1]), // Mock extent to return a default range
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

jest.mock('d3-contour', () => ({
  contourDensity: jest.fn(() => ({
      x: jest.fn(() => ({
          y: jest.fn(() => ({
              size: jest.fn(() => ({
                  bandwidth: jest.fn(() => jest.fn())
              }))
          }))
      }))
  }))
}));

jest.mock('d3-scale-chromatic', () => ({
  interpolateYlGnBu: jest.fn()
}));

jest.mock('d3-geo', () => ({
  geoPath: jest.fn()
}));

import * as d3 from 'd3';

// Mock data (replace with your actual data structure)
const mockProps = {
  math: {
    "base-clusters": { count: { id1: 10, id2: 5 }, id: 0, x: 0, y: 0 },
    "group-clusters": [
      { id: 0, center: [0.5, 0.5] },
      { id: 1, center: [0.2, 0.8] },
    ],
    tids: ['tid1', 'tid2'],
    pca: {
      'comment-projection': [
        [],
        []
      ]
    }
  },
  comments: [
    { tid: 'tid1', text: 'Comment 1' },
    { tid: 'tid2', text: 'Comment 2' },
  ],
  voteColors: { agree: 'green', disagree: 'red' },
  // Add other props as needed
};

// Test case for rendering with basic data
test('renders participants graph with basic data', () => {
  render(<ParticipantsGraph {...mockProps} />);

  // Check for presence of elements
  expect(screen.getByRole('button', { name: 'Axes' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Statements' })).toBeInTheDocument();

  // Check for group labels (if data includes group labels)
  if (mockProps.math["group-clusters"][0].hasOwnProperty('label')) {
    expect(screen.getByText(mockProps.math["group-clusters"][0].label)).toBeInTheDocument();
  }
});

// Test case for clicking "Statements" button
test('clicking statements button shows comments', () => {
  render(<ParticipantsGraph {...mockProps} />);

  const statementsButton = screen.getByRole('button', { name: 'Statements' });
  expect(statementsButton.textContent).toBe('Statements');

  fireEvent.click(statementsButton);

  // Check for presence of comments (implementation might vary)
  expect(screen.getByText('Comment 1')).toBeInTheDocument();
});


