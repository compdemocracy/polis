import React, { useState } from 'react';
import { Statement } from './Statement';
import EmailSubscribeForm from './EmailSubscribeForm';

// This is a mock of the 'vote' API call.
// In a real app, it would POST to a polis endpoint with the vote,
// and the response would contain the `nextComment`.
const submitVoteAndGetNextCommentAPI = async (vote, participationInfo) => {
  console.log('Submitting vote to polis:', { ...vote, ...participationInfo });
  // MOCKING: Return a new comment after a delay.
  return new Promise(resolve => {
    setTimeout(() => {
      const nextTid = Math.floor(Math.random() * 1000);
      resolve({
        success: true,
        nextComment: {
          tid: nextTid,
          txt: `This is the next comment (id: ${nextTid}), fetched from the client after a vote.`
        }
      });
    }, 800);
  });
};


export default function Survey({ initialStatement, participationInfo, s }) {
  const [statements, setStatements] = useState([initialStatement]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFetchingNext, setIsFetchingNext] = useState(false);

  const handleVote = async (voteType, tid) => {
    setIsFetchingNext(true);
    
    const vote = { vote: voteType, tid: tid };
    const result = await submitVoteAndGetNextCommentAPI(vote, participationInfo);

    setIsFetchingNext(false);

    if (result.success && result.nextComment) {
      setStatements(prev => [...prev, result.nextComment]);
      setCurrentIndex(prev => prev + 1);
    } else {
      setCurrentIndex(prev => prev + 1);
    }
  };

  const currentStatement = statements[currentIndex];

  return (
    <>
      {currentStatement ? (
        <Statement
          statement={currentStatement}
          onVote={handleVote}
          isVoting={isFetchingNext}
          s={s}
        />
      ) : (
        <EmailSubscribeForm s={s} />
      )}
    </>
  );
}
