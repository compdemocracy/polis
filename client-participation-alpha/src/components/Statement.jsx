import React, { useState } from 'react';

export function Statement({ statement, onVote, isVoting, s, isStatementImportant, setIsStatmentImportant, voteError }) {
  const [showImportanceDesc, setShowImportanceDesc] = useState(false);

  const handleVoteClick = (voteType) => {
    if (isVoting) return;
    onVote(voteType, statement.tid);
  };

  const passUnsureText = s.pass;

  return (
    <div className="statement-card">
      <div className="statement-header">
        <div className="anonymous-user">
          <div className="avatar"></div>
          <span>{s.anonPerson || 'Anonymous'} {s.x_wrote || 'wrote:'}</span>
        </div>
      </div>
      <p className="statement-text">{statement.txt}</p>

      <div className="importance-container">
        <label htmlFor="important">
          {s.importantCheckbox || 'Mark as important'}
        </label>
        <input 
          id="important" 
          type="checkbox" 
          onChange={() => setIsStatmentImportant(prev => !prev)} 
          checked={isStatementImportant}
        />
        <svg 
          onClick={() => setShowImportanceDesc(prev => !prev)} 
          viewBox="0 0 512 512" 
          xmlns="http://www.w3.org/2000/svg" 
          height="17px" 
          width="17px"
          className="info-icon"
        >
          <path d="M256 0C114.6 0 0 114.6 0 256s114.6 256 256 256s256-114.6 256-256S397.4 0 256 0zM256 464c-114.7 0-208-93.31-208-208S141.3 48 256 48s208 93.31 208 208S370.7 464 256 464zM256 336c-18 0-32 14-32 32s13.1 32 32 32c17.1 0 32-14 32-32S273.1 336 256 336zM289.1 128h-51.1C199 128 168 159 168 198c0 13 11 24 24 24s24-11 24-24C216 186 225.1 176 237.1 176h51.1C301.1 176 312 186 312 198c0 8-4 14.1-11 18.1L244 251C236 256 232 264 232 272V288c0 13 11 24 24 24S280 301 280 288V286l45.1-28c21-13 34-36 34-60C360 159 329 128 289.1 128z"></path>
        </svg>
      </div>

      {showImportanceDesc && (
        <p className="importance-desc">
          {s.importantCheckboxDesc || 'Marking a statement as important gives it a higher priority in the analysis.'}
        </p>
      )}

      <div className="vote-buttons">
        <button className="vote-button agree" onClick={() => handleVoteClick(-1)} disabled={isVoting}>
          {isVoting ? s.voting : `✔ ${s.agree}`}
        </button>
        <button className="vote-button disagree" onClick={() => handleVoteClick(1)} disabled={isVoting}>
          {isVoting ? s.voting : `✘ ${s.disagree}`}
        </button>
        <button className="vote-button pass" onClick={() => handleVoteClick(0)} disabled={isVoting}>
          {isVoting ? s.voting : passUnsureText}
        </button>
      </div>
      {voteError && (
        <p className="vote-error">
          {voteError}
        </p>
      )}
    </div>
  );
}
