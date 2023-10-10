import React, { useState, useEffect } from "react";
import { Box, Button } from "theme-ui";
import UnderstandAI from "./UnderstandAI";
import IndividualDeliberation from "./IndividualDeliberation";
import ProgressBar from "./Progressbar";
import Tutorial from "./Tutorial";
import ConversationUI from "./ConversationUI";
import Legal from "./Legal";

const Deliberation = (props = {}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [progress, setProgress] = useState(33.3);
  const [currentTutorialIndex, setCurrentTutorialIndex] = useState(0);
  const [isConversationExists, setIsConversationExists] = useState(null);
  // const [responseObject, setResponseObject] = useState({});


  const handleNextClick = () => {
    setCurrentTutorialIndex(currentTutorialIndex+1)
    if (currentIndex < 3) {
      setCurrentIndex(currentIndex + 1);
      setProgress(progress + 25);
    }
  };

  const testProps = {
    match: {
      params: {
        conversation_id: '8hjyvcneet', 
      },
    },
    response: {
      nextComment: {
        tid: 1,
        txt: 'This is a test comment.',
        remaining: 5,
      },
      ptpt: {
        pid: 1, 
        subscribed: false,
      },
      user: {
        email: 'janst.geo@gmail.com', 
      },
      conversation: {
        topic: 'Test Conversation',
        description: 'This is a test conversation for development purposes.',
        is_active: true,
        subscribe_type: 1,
        help_type: 1,
        write_type: 1,
        vis_type: 1,
      },
    },
  };

  // useEffect(() => {
  //   // Replace 'yourConversationId' with the actual conversation ID you want to check
  //   isMatch('8hjyvcneet')
  //     .then((status) => {
  //       setResponseObject(status.response);
  //       setIsConversationExists(status.wasSuccessful);
  //     })
  //     .catch((status) => setIsConversationExists(status.wasSuccessful));
  // }, []); // Add dependencies if necessary

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
      {currentIndex === 2 &&  <Legal/>}
      {currentIndex === 3 && isConversationExists && <ConversationUI response={testProps} />}
      {(!props.finishedTutorial && currentTutorialIndex != 3 && currentTutorialIndex != 6 && currentTutorialIndex != 10)&& <Tutorial setCurrentIndex={setCurrentTutorialIndex} currentIndex={currentTutorialIndex} email={props} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <ProgressBar progress={progress} fillerStyles={fillerStyles}></ProgressBar>
        {(currentTutorialIndex === 3 || currentTutorialIndex === 6 || currentTutorialIndex === 10) && <Button onClick={handleNextClick} sx={{ marginLeft: '10px' }}>Next</Button>}
      </div>
    </Box>
  );
};

export default Deliberation;
