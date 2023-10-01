import React from 'react';
import TutorialBox from "./TutorialBox";


const Tutorial = ({ setCurrentIndex, currentIndex }) => {
    const styles = {
        cls1: {
          fill: '#a0470d',
          fillRule: 'evenodd'
        },
        cls2: {
          fill: '#edc797',
          fillRule: 'evenodd'
        },
        cls3: {
          fill: '#f7d7b1',
          fillRule: 'evenodd'
        },
        cls4: {
          fill: '#39474a',
          fillRule: 'evenodd'
        },
        cls5: {
          fill: '#fff',
          fillRule: 'evenodd'
        },
        cls6: {
          fill: '#bf9e83',
          fillRule: 'evenodd'
        },
        cls7: {
          fill: '#3f3d31',
          fillRule: 'evenodd'
        },
        circle: {
            width: '120px', 
            height: '120px',
            borderRadius: '50%', 
            backgroundColor: '#F4511E', 
            position: 'fixed', 
            bottom: '30px',
            right: '30px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          },
      };
  return (
    <div>


<div style={styles.circle} >
        <svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 122.88 107.32" style={{width: '73%', height: 'auto'}}>
  <defs></defs>
  <title>dog-face-color</title>
  <path style={styles.cls1} d="M37.45,4c-16.74,4.38-14.14,28.52-17.6,42.3C18.76,50.66,15.46,61.22,10,61,4,60.74,4.73,42.7,4.46,38,4.28,34.83,3.8,28.85,0,27.81,7.15,2.49,19.52-5.83,37.45,4Z"/>
  <path style={styles.cls2} d="M102.37,34.73c1.12,8.6,2.2,16.9,5.91,21.58a1.15,1.15,0,0,1,.22.87,46,46,0,0,1-7,18.08A36.25,36.25,0,0,1,89.26,86.4a31.3,31.3,0,0,1-2.88,3.65s0,0,0,0L86.27,90h0c-1.16,6.64-4,11.06-8.35,13.8s-9.82,3.69-16.46,3.55c-15.66-.35-21.59-6.39-23.7-11.26a14,14,0,0,1-1-3.36,10.12,10.12,0,0,1-.07-2.4l0-.16a14.54,14.54,0,0,1-1.61-1.63,9.3,9.3,0,0,1-1.36-2.12A36.37,36.37,0,0,1,21.58,75.26a45.87,45.87,0,0,1-7-18.05,1.1,1.1,0,0,1,.12-.77c4.41-7.54,5.45-16.37,6.42-24.64C22.63,19,24,7.41,37,3a1.13,1.13,0,0,1,.73,0A16.07,16.07,0,0,0,40,3.52a18.28,18.28,0,0,0,2.3.19,16,16,0,0,0,5.77-1C50.77,1.85,54,.82,61.59.88A45.84,45.84,0,0,1,75.22,2.77a18.71,18.71,0,0,0,6,1,13.16,13.16,0,0,0,2-.2,13.44,13.44,0,0,0,2-.52,1.12,1.12,0,0,1,.68,0c12.91,3.42,14.8,18,16.6,31.74Zm-16.09,55V90l.08.07c0-.12-.07-.54-.07-.25Z"/>
  <path style={styles.cls3} d="M107.43,57C97.55,44.53,105.65,9.38,85.49,4a13.72,13.72,0,0,1-4.28.79C75.53,5,73.49,2.05,61.58,2,48.86,1.87,48.71,4.89,42.31,4.79A17,17,0,0,1,37.45,4C16.64,11,26.91,37.73,15.64,57c2.57,14.27,9.34,23.26,19,28.63A10.5,10.5,0,0,0,38,89.77c-.57,0-2.06,15.89,23.47,16.45,12.87.28,21.51-3.82,23.72-16.45,0,0,2.87-3.18,3.25-4.15,9.65-5.37,16.42-14.36,19-28.63Z"/>
  <path style={styles.cls1} d="M85.43,4c16.74,4.38,14.14,28.52,17.6,42.3,1.09,4.32,4.39,14.88,9.83,14.65,6-.25,5.29-18.29,5.56-23,.18-3.17.66-9.15,4.46-10.19C115.72,2.49,103.36-5.83,85.43,4Z"/>
  <path style={styles.cls4} d="M40.76,37.69h0a6.92,6.92,0,0,1,6.89,6.89v3.89a6.92,6.92,0,0,1-6.89,6.89h0a6.91,6.91,0,0,1-6.89-6.89V44.58a6.91,6.91,0,0,1,6.89-6.89Z"/>
  <path style={styles.cls5} d="M40.64,39.57a3,3,0,1,1-3,3,3,3,0,0,1,3-3Z"/>
  <path style={styles.cls4} d="M82.18,37.69h0a6.92,6.92,0,0,0-6.9,6.89V48.1A6.92,6.92,0,0,0,82.18,55h0a6.91,6.91,0,0,0,6.89-6.89V44.58a6.91,6.91,0,0,0-6.89-6.89Z"/>
  <path style={styles.cls5} d="M82.3,39.57a3,3,0,1,0,3,3,3,3,0,0,0-3-3Z"/>
  <path style={styles.cls6} d="M61.43,93.56h0c10.67,5.25,19.1,3.29,24.72-7.69,1.75-3.41,1.5-4.83-.17-8.23-.48-1-1-1.9-1.47-2.84A190.34,190.34,0,0,0,74.08,57.43c-2-2.91-3.84-6-7-7.71a12.5,12.5,0,0,0-11.18,0c-3.21,1.68-5.08,4.8-7.05,7.71A190.34,190.34,0,0,0,38.35,74.8c-.5.94-1,1.88-1.47,2.84-1.67,3.4-1.92,4.82-.17,8.23,5.62,11,14,12.94,24.72,7.69Z"/>
  <path style={styles.cls7} d="M70.55,77a21.91,21.91,0,0,1-9.06,5.9,24.25,24.25,0,0,1-8.88-5.77c-1.53-1.66-2.17-2.29-1.94-4.56a6.58,6.58,0,0,1,2.1-4.32c3.83-3.51,13.12-3.58,17.09-.21a6.51,6.51,0,0,1,2.24,4c.42,2.38,0,3.21-1.55,5Z"/>
</svg>
    </div>
    <TutorialBox heading={"Welcome to Polis"} description={['My name is Charlie and I am here to to help you to train your AI with the right attributes.', 'If you want to learn more about AI, this highlighted YouTube Video will help you to understand the topic. If you got any further question you can read the rest of the page.', 'Now you can familirize yourself with the basics of AI and aftwards you can start voting on your first poll.']} currentIndex={currentIndex} setCurrentIndex={setCurrentIndex}></TutorialBox>
    </div>
    
  );
};



export default Tutorial;
