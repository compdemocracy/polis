import React, { useState } from 'react';
import { Statement } from './Statement';
import EmailSubscribeForm from './EmailSubscribeForm';
import { getPreferredLanguages } from '../strings/strings';


const submitVoteAndGetNextCommentAPI = async (vote, conversation_id) => {
  console.log('Submitting vote to polis:', { ...vote, ...participationInfo });
  try {
    const response = await fetch(`${process.env.SERVICE_URL}/votes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agid: 1, // todo - fix
        conversation_id,
        high_priority: false, // todo - fix
        lang: getPreferredLanguages()[0],
        pid: "mypid", // todo - fix
        tid: 495, // todo - fix
        vote,
      }),
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Vote failed');
    }

    const data = await response.json();
    return data;
  } catch (error) {
    
  }
};


export default function Survey({ initialStatement, participationInfo, s, conversation_id }) {
  const [statements, setStatements] = useState([initialStatement]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFetchingNext, setIsFetchingNext] = useState(false);

  const handleVote = async (voteType, tid) => {
    setIsFetchingNext(true);
    
    const vote = { vote: voteType, tid: tid };
    const result = await submitVoteAndGetNextCommentAPI(vote, conversation_id);

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
