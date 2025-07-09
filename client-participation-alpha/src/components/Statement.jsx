import React from 'react';

export function Statement({ statement, onVote, isVoting, s }) {

  const handleVoteClick = (voteType) => {
    if (isVoting) return;
    onVote(voteType, statement.id);
  };

  const passUnsureText = s.pass;

  return (
    <div className="statement-card">
      <div className="statement-header">
        <div className="anonymous-user">
          <div className="avatar"></div>
          <span>{s.anonPerson} {s.x_wrote}</span>
        </div>
      </div>
      <p className="statement-text">{statement.text}</p>
      <div className="vote-buttons">
        <button className="vote-button agree" onClick={() => handleVoteClick('agree')} disabled={isVoting}>
          {isVoting ? s.voting : `✔ ${s.agree}`}
        </button>
        <button className="vote-button disagree" onClick={() => handleVoteClick('disagree')} disabled={isVoting}>
          {isVoting ? s.voting : `✘ ${s.disagree}`}
        </button>
        <button className="vote-button pass" onClick={() => handleVoteClick('pass')} disabled={isVoting}>
          {isVoting ? s.voting : passUnsureText}
        </button>
      </div>
    </div>
  );
}
