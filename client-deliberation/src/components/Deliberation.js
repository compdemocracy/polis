import React, { useState } from "react";
import { Box, Button } from "theme-ui";
import UnderstandAI from "./UnderstandAI";
import IndividualDeliberation from "./IndividualDeliberation";
import ProgressBar from "./Progressbar";
import Tutorial from "./Tutorial";

const Deliberation = (props = {}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [progress, setProgress] = useState(33.3);
  const [currentTutorialIndex, setCurrentTutorialIndex] = useState(0);

  const handleNextClick = () => {
    setCurrentTutorialIndex(currentTutorialIndex+1)
    if (currentIndex < 2) {
      setCurrentIndex(currentIndex + 1);
      setProgress(progress + 33.3);
    }
  };

  const fillerStyles = {
    height: '100%',
    width: `${progress}%`,
    backgroundColor: '#F4511E',
    borderRadius: 'inherit',
    transition: 'width 1s ease-in-out'
  }

  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px"}}>
      {currentIndex === 0 && <IndividualDeliberation {...props} currentIndex={currentIndex} />}
      {currentIndex === 1 && <UnderstandAI {...props} />}
      {currentIndex === 2 && <a href="http://localhost:5000/8hjyvcneet" target="_blank" rel="noopener noreferrer">Go to Next Section</a>}
      {(!props.finishedTutorial && currentTutorialIndex != 3 && currentTutorialIndex != 6)&& <Tutorial setCurrentIndex={setCurrentTutorialIndex} currentIndex={currentTutorialIndex} email={props} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <ProgressBar progress={progress} fillerStyles={fillerStyles}></ProgressBar>
        {(currentTutorialIndex === 3 || currentTutorialIndex === 6) && <Button onClick={handleNextClick} sx={{ marginLeft: '10px' }}>Next</Button>}
      </div>
    </Box>
  );
};

export default Deliberation;
