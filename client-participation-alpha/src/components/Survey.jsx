import React, { useState } from 'react';
import { Statement } from './Statement';
import EmailSubscribeForm from './EmailSubscribeForm';
import { getPreferredLanguages } from '../strings/strings';


const submitVoteAndGetNextCommentAPI = async (vote, conversation_id, high_priority = false) => {
  try {
    const response = await fetch(`${import.meta.env.PUBLIC_SERVICE_URL}/votes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agid: 1,
        conversation_id,
        high_priority,
        lang: getPreferredLanguages()[0],
        pid: "mypid", // todo - fix - wait for new auth
        tid: vote.tid,
        vote: vote.vote,
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


export default function Survey({ initialStatement, s, conversation_id }) {
  const [statement, setStatement] = useState(initialStatement);
  const [isFetchingNext, setIsFetchingNext] = useState(false);
  const [isStatementImportant, setIsStatmentImportant] = useState(false);


  const handleVote = async (voteType, tid) => {
    setIsFetchingNext(true);
    
    const vote = { vote: voteType, tid: tid };
    const result = await submitVoteAndGetNextCommentAPI(vote, conversation_id, isStatementImportant);

    setIsFetchingNext(false);

    if (result?.nextComment) {
      setStatement(result.nextComment);
    } else {
      setStatement(undefined);
    }
    // reset importance checkbox
    setIsStatmentImportant(false);
  };


  return (
    <>
      {statement ? (
        <Statement
          statement={statement}
          onVote={handleVote}
          isVoting={isFetchingNext}
          s={s}
          isStatementImportant={isStatementImportant}
          setIsStatmentImportant={setIsStatmentImportant}
        />
      ) : (
        <EmailSubscribeForm s={s} />
      )}
    </>
  );
}
