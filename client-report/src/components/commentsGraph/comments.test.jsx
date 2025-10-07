import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Comments from './comments'; // Update with the correct path to your component
import '@testing-library/jest-dom';

describe('Comments Component', () => {
  const mockPoints = [
    { tid: 1, x: 10, y: 20 },
    { tid: 2, x: 30, y: 40 },
    { tid: 3, x: 50, y: 60 },
  ];
  const mockFormatTid = (tid) => `TID-${tid}`;
  const mockHandleClick = jest.fn();
  const mockComments = [
    { tid: 1, text: 'Comment 1', is_meta: false },
    { tid: 2, text: 'Comment 2', is_meta: true }, // This comment should be skipped
    { tid: 3, text: 'Comment 3', is_meta: false },
  ];
  const mockXCenter = 100;
  const mockXScaleup = 2;
  const mockYCenter = 200;
  const mockYScaleup = 3;

  it('renders comments correctly', () => {
    render(
      <svg>
        <Comments
          points={mockPoints}
          formatTid={mockFormatTid}
          handleClick={mockHandleClick}
          comments={mockComments}
          xCenter={mockXCenter}
          xScaleup={mockXScaleup}
          yCenter={mockYCenter}
          yScaleup={mockYScaleup}
        />
      </svg>
    );

    // Check if the correct number of comments are rendered (excluding the meta comment)
    expect(screen.getAllByText(/TID-/i)).toHaveLength(2); 
  });

  it('calls handleClick when a comment is clicked', () => {
    render(
      <svg>
        <Comments
          points={mockPoints}
          formatTid={mockFormatTid}
          handleClick={mockHandleClick}
          comments={mockComments}
          xCenter={mockXCenter}
          xScaleup={mockXScaleup}
          yCenter={mockYCenter}
          yScaleup={mockYScaleup}
        />
      </svg>
    );

    // Simulate click on the first comment
    fireEvent.click(screen.getByText('TID-1')); 

    // Check if handleClick was called with the correct comment object
    expect(mockHandleClick).toHaveBeenCalledWith(mockPoints[0]); 
  });
});