import React, { useState } from 'react';

// This is a mock API call function. 
// Replace it with your actual API call.
// It resolves successfully after 750ms.
const submitVoteAPI = (voteType) => {
  console.log(`Submitting vote: ${voteType}`);
  return new Promise(resolve => {
    setTimeout(() => {
      console.log('Vote submitted successfully.');
      resolve({ success: true });
    }, 750);
  });
};

export default function Statement({ statement, onVoteSuccess }) {
  const [isVoting, setIsVoting] = useState(false);

  const handleVote = async (voteType) => {
    if (isVoting) return; // Prevent multiple clicks
    setIsVoting(true);

    try {
      const result = await submitVoteAPI(voteType);
      if (result.success) {
        onVoteSuccess(() => setIsVoting(false)); // Tell the parent component to show the next card
      }
    } catch (error) {
      console.error("Failed to submit vote:", error);
      // Optionally, show an error message to the user
    } finally {
      // Don't set isVoting back to false, as we are moving to the next card
    }
  };

  return (
    <div className="statement-card">
      <div className="statement-header">
        <div className="anonymous-user">
          <div className="avatar"></div>
          <span>Anonymous wrote: {statement.body}</span>
        </div>
        <span>{statement.remaining} remaining</span>
      </div>
      <p className="statement-text">{statement.text}</p>
      <div className="vote-buttons">
        <button className="vote-button agree" onClick={() => handleVote('agree')} disabled={isVoting}>
          {isVoting ? 'Voting...' : '✔ Agree'}
        </button>
        <button className="vote-button disagree" onClick={() => handleVote('disagree')} disabled={isVoting}>
          ✘ Disagree
        </button>
        <button className="vote-button pass" onClick={() => handleVote('pass')} disabled={isVoting}>
          Pass / Unsure
        </button>
      </div>
    </div>
  );
}