import React from 'react';

const PolisButton = ({ onClick, buttonText }) => { // Corrected the destructuring here
    return (
      <button 
        onClick={onClick} 
    style={{
        position: 'absolute',
        bottom: '-10px',
        right: '0',
        cursor: 'pointer',
        color: '#FFFFFF', 
        backgroundColor: '#F4511E',
        padding: '10px 20px', 
        fontSize: '16px', 
        border: 'none', 
        borderRadius: '4px', 
        boxShadow: '0px 4px 6px rgba(0, 0, 0, 0.1)', 
        transition: 'background-color 0.3s, color 0.3s', 
        ':hover': {
          backgroundColor: '#D1491B', 
          color: '#FFF' 
        },
        ':focus': {
          outline: 'none'
        }
      }}>
        {buttonText}
      </button>
  );
};

export default PolisButton;
