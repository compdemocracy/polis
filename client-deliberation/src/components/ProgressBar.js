import React from 'react';

const ProgressBar = ({ progress, fillerStyles }) => {
    const containerStyles = {
        height: '20px',
        width: '70%',
        backgroundColor: '#e0e0df',
        borderRadius: '50px',
        margin: '10px 0',
        display: 'inline-block'
      }
    
      

  return (
    <div style={containerStyles}>
      <div style={fillerStyles}></div>
    </div>
  );
};

export default ProgressBar;
