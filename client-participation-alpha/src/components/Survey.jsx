import React, { useEffect, useState } from 'react';
import { Statement } from './Statement';
import EmailSubscribeForm from './EmailSubscribeForm';
import { getPreferredLanguages } from '../strings/strings';
import { getConversationToken } from '../lib/auth';
import PolisNet from '../lib/net';

const submitVoteAndGetNextCommentAPI = async (vote, conversation_id, high_priority = false) => {
  const decodedToken = getConversationToken(conversation_id);
  
  try {
    const resp = await PolisNet.polisPost('/votes', {
      agid: 1,
      conversation_id,
      high_priority,
      lang: getPreferredLanguages()[0],
      pid: decodedToken?.pid || -1,
      tid: vote.tid,
      vote: vote.vote,
    });
    
    return resp;
  } catch (error) {
    // The net module already handles JWT extraction and storage
    // Just re-throw the error for the component to handle
    throw error;
  }
};


export default function Survey({ initialStatement, s, conversation_id }) {
  const [statement, setStatement] = useState(initialStatement);
  const [isFetchingNext, setIsFetchingNext] = useState(false);
  const [isStatementImportant, setIsStatmentImportant] = useState(false);
  const [voteError, setVoteError] = useState(null);

  // On hydration, fetch a participant-personalized next comment.
  // This replaces the SSR-provided generic comment if needed.
  useEffect(() => {
    let cancelled = false;
    const loadPersonalizedFirst = async () => {
      try {
        const decodedToken = getConversationToken(conversation_id);
        const pid = decodedToken?.pid ?? -1;
        const lang = getPreferredLanguages()[0];
        const resp = await PolisNet.polisGet('/nextComment', {
          conversation_id,
          lang
        });

        if (!cancelled) {
          if (resp && typeof resp.tid !== 'undefined') {
            const mapped = { tid: resp.tid, txt: resp.txt, remaining: resp.remaining };
            if (!statement || mapped.tid !== statement.tid) {
              setStatement(mapped);
            }
          } else {
            // No personalized next comment available; hide the SSR fallback.
            setStatement(undefined);
          }
        }
      } catch (e) {
        // Non-fatal; keep SSR statement
        console.warn('Personalized first comment fetch failed', e);
      }
    };
    loadPersonalizedFirst();
    return () => {
      cancelled = true;
    };
  // Run once on mount for this conversation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation_id]);

  const handleVote = async (voteType, tid) => {
    setIsFetchingNext(true);
    setVoteError(null);
    
    try {
      const vote = { vote: voteType, tid: tid };
      const result = await submitVoteAndGetNextCommentAPI(vote, conversation_id, isStatementImportant);

      setVoteError(null);
      if (result?.nextComment) {
        setStatement(result.nextComment);
      } else {
        setStatement(undefined);
      }
      setIsStatmentImportant(false);

    } catch (error) {
      console.error("Vote submission failed:", error);
      let errorMessage = s.commentSendFailed || "Apologies, your vote failed to send. Please check your connection and try again.";

      // Check error.responseText first (from net.js), then fall back to error.message
      const errorText = error.responseText || error.message || '';
      
      if (errorText.includes("polis_err_conversation_is_closed")) {
        errorMessage = s.convIsClosed || "This conversation is closed. No further voting is allowed.";
      } else if (errorText.includes("polis_err_post_votes_social_needed")) {
        errorMessage = "You need to sign in to vote.";
      } else if (errorText.includes("polis_err_xid_not_whitelisted")) {
        errorMessage = "Sorry, you must be registered to vote. Please sign in or contact the conversation owner.";
      }
      
      setVoteError(errorMessage);
    } finally {
      setIsFetchingNext(false);
    }
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
          voteError={voteError}
        />
      ) : (
        <EmailSubscribeForm s={s} conversation_id={conversation_id} />
      )}
    </>
  );
}
