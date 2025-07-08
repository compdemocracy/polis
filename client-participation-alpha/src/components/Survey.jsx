import React, { useState } from 'react';
import Statement from './Statement';
import SurveyForm from './SurveyForm';
import EmailSubscribeForm from './EmailSubscribeForm';

export function Survey({ initialStatements }) {
  const [currentIndex, setCurrentIndex] = useState(0);

  // Add a 'remaining' count to each statement
  const statements = initialStatements.map((stmt, index) => ({
    ...stmt,
    remaining: initialStatements.length - index,
  }));

  const handleNextStatement = (cb) => {
    setCurrentIndex(prevIndex => prevIndex + 1);
    cb();
  };

  const currentStatement = statements[currentIndex];

  return (
    <>
      {currentStatement ? (
        <>
          <Statement
            statement={currentStatement}
            onVoteSuccess={handleNextStatement}
          />
          <SurveyForm />
        </>
      ) : (
        <div>
          <p style={{ textAlign: 'center', marginBottom: '2rem' }}>All statements viewed.</p>
          <EmailSubscribeForm />
        </div>
      )}
    </>
  );
}

export default Survey;