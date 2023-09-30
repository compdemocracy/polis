import React from 'react';
import { Box } from "theme-ui";

const TutorialBox = ({ heading, description}) => {
  return (
    <Box sx={{ 
        backgroundColor: '#F1F1F1',
        borderRadius: '8px',
        padding: '15px',
        position: 'fixed', // Changed from 'relative' to 'fixed'
        color: 'black',
        mb: [4],
        bottom: '80px', // Added to position at bottom
        right: '125px',  // Added to position at right
        width: '600px', // You may need to set a width
        margin: '10px',
      }}>
         <h2 style={{marginTop: '0px', marginBottom: '10px'}}>{heading}</h2>
        <Box sx={{ 
            display: 'flex', 
            justifyContent: 'space-between',
            alignItems: 'initial',
          }}>
            <Box sx={{ marginRight: '10px' }}>
              <div>{description}</div>
            </Box>
          </Box>
      </Box>
  );
};

export default TutorialBox;
