import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import BoxPlot from './boxPlot';
import drawBoxPlot from './drawBoxPlot';
import * as globals from '../globals'; // Import globals if needed

// Mock drawBoxPlot function
jest.mock('./drawBoxPlot', () => jest.fn());

describe('BoxPlot Component', () => {
  const mockGroupVotes = {
    group1: {
      id: 0,
      votes: [
        { S: 10, A: 5 }, // 50% agreement
        { S: 8, A: 2 }, // 25% agreement
      ],
    },
    group2: {
      id: 1,
      votes: [
        { S: 12, A: 8 }, // 66.67% agreement
        { S: 5, A: 1 }, // 20% agreement
      ],
    },
  };

  it('renders without crashing', () => {
    render(<BoxPlot groupVotes={mockGroupVotes} />);
  });

  it('calls drawBoxPlot with the correct dataset', () => {
    render(<BoxPlot groupVotes={mockGroupVotes} />);

    // Check if drawBoxPlot was called with the expected dataset
    expect(drawBoxPlot).toHaveBeenCalledWith([
      ['A', [50, 25]], // Assuming globals.groupLabels[0] is 'A'
      ['B', [66, 20]], // Assuming globals.groupLabels[1] is 'B'
    ]);
  });

  it('renders the headings and paragraphs', () => {
    render(<BoxPlot groupVotes={mockGroupVotes} />);

    // Check if the primary heading is rendered
    expect(
      screen.getByText('Average level of agreement per group')
    ).toHaveStyle(globals.primaryHeading); // Assuming globals.primaryHeading has styles

    // Check if the paragraphs are rendered
    expect(screen.getByText(/Which group agreed the most/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /The line in the middle of the blue boxes below shows the mean/i
      )
    ).toBeInTheDocument();
    // Add more expectations for other paragraphs as needed
  });

  it('renders the link to Khan Academy', () => {
    render(<BoxPlot groupVotes={mockGroupVotes} />);

    const linkElement = screen.getByRole('link', {
      name: /How to read a box plot/i,
    });
    expect(linkElement).toHaveAttribute(
      'href',
      'https://www.khanacademy.org/math/probability/data-distributions-a1/box--whisker-plots-a1/v/reading-box-and-whisker-plots'
    );
    expect(linkElement).toHaveAttribute('target', '_blank');
  });
});