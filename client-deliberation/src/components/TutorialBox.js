import React, {useState} from 'react';
import { Box } from "theme-ui";
import ArrowIcon from './ArrowIcon';
import PolisButton from './PolisButton';

const TutorialBox = ({ heading, description, currentIndex, setCurrentIndex  }) => {

  

  // Check if description is an array, if not, use the provided description
  const descArray = Array.isArray(description) ? description : [description];

    // Handle the right arrow click
    const handleRightArrowClick = () => {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % descArray.length);
    };
  
    // Handle the left arrow click
    const handleLeftArrowClick = () => {
      setCurrentIndex((prevIndex) => (prevIndex - 1 + descArray.length) % descArray.length);
    };

  return (
    <Box sx={{ 
        backgroundColor: '#F1F1F1',
        borderRadius: '8px',
        padding: '15px',
        position: 'fixed',
        color: 'black',
        mb: [4],
        bottom: '80px',
        right: '125px',
        width: '600px',
        margin: '10px',
      }}>
         <h2 style={{marginTop: '0px', marginBottom: '10px'}}>{heading}</h2>
        <Box sx={{ 
            display: 'flex', 
            justifyContent: 'space-between',
            alignItems: 'initial',
            position: 'relative',
          }}>
            {currentIndex > 0 &&
            <ArrowIcon onClick={handleLeftArrowClick} style={{ position: 'absolute', bottom: '-10px', left: '0', cursor: 'pointer', transform: 'rotate(180deg)'}} />}
            <Box sx={{ marginRight: '10px', marginBottom: '30px'}}>
                <div>{descArray[currentIndex]}</div> 
            </Box>
            {currentIndex === descArray.length - 1 ? (  
              <PolisButton onClick={console.log("Polis Button Pressed")} buttonText={'Starts'}></PolisButton>
            ) : (
            <ArrowIcon onClick={handleRightArrowClick} style={{ position: 'absolute', bottom: '-10', right: '0', cursor: 'pointer' }} />)}
          </Box>
      </Box>
  );
};

export default TutorialBox;
