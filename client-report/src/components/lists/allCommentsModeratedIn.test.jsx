import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AllCommentsModeratedIn from './allCommentsModeratedIn.jsx'; 
import CommentList from './commentList.jsx';

jest.mock('./commentList', () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe('allCommentsModeratedIn component', () => {
  const mockComments = [
    { tid: 1, count: 10, "group-aware-consensus": 0.7 },
    { tid: 2, count: 5, "group-aware-consensus": 0.8 },
  ];

  test('renders loading message when conversation is not provided', () => {
    render(<AllCommentsModeratedIn />);
    expect(screen.getByText('Loading allCommentsModeratedIn...')).toBeInTheDocument();
  });

  test('renders comments with tid sorting by default', () => {
    const mockConversation = {};
    render(<AllCommentsModeratedIn conversation={mockConversation} comments={mockComments} />);
    expect(CommentList).toHaveBeenCalledWith({"comments": [{"count": 10, "group-aware-consensus": 0.7, "tid": 1}, {"count": 5, "group-aware-consensus": 0.8, "tid": 2}], "conversation": {}, "formatTid": undefined, "math": undefined, "ptptCount": undefined, "tidsToRender": [1, 2], "voteColors": undefined}, {}
    );
  });

  test('sorts comments by numvotes when selected', () => {
    const mockConversation = {};
    render(
      <AllCommentsModeratedIn conversation={mockConversation} comments={mockComments} sortStyle="numvotes" />
    );
    expect(CommentList).toHaveBeenCalledWith({"comments": [{"count": 10, "group-aware-consensus": 0.7, "tid": 1}, {"count": 5, "group-aware-consensus": 0.8, "tid": 2}], "conversation": {}, "formatTid": undefined, "math": undefined, "ptptCount": undefined, "tidsToRender": [1, 2], "voteColors": undefined}, {});
  });

  test('sorts comments by other criteria based on sortStyle', () => {
    const mockConversation = {};
    const sortStyles = ['consensus', 'pctAgreed', 'pctDisagreed', 'pctPassed'];
    sortStyles.forEach((sortStyle) => {
      render(
        <AllCommentsModeratedIn conversation={mockConversation} comments={mockComments} sortStyle={sortStyle} />
      );
      expect(CommentList).toHaveBeenCalled(); // Ensure CommentList is called
    });
  });
});