import React from 'react';
import { Box } from "theme-ui";

const IntegrateDescription = ({ heading, description, items }) => {
  return (
    <Box sx={{ 
        backgroundColor: '#F1F1F1',
        borderRadius: '8px',
        padding: '15px',
        position: 'relative',
        color: 'black',
        mb: [4],
      }}>
         <h2 style={{marginTop: '0px', marginBottom: '10px'}}>{heading}</h2>
        <Box sx={{ 
            display: 'flex', 
            justifyContent: 'space-between',
            alignItems: 'initial',
          }}>
            <Box sx={{ marginRight: '10px' }}>
              <div>{description}</div>
              {Array.isArray(items) && items.length > 0 && (
                <ul>
                  {items.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              )}
            </Box>
          </Box>
      </Box>
  );
};

export default IntegrateDescription;
