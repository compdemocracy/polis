import React, { useState }  from "react";
import { Box, Button } from "theme-ui";

const Integrate = ({link}) => {

  const [currentSvg, setCurrentSvg] = useState("original"); // Initial SVG

  const copy_link_poli = () => {
    setCurrentSvg(currentSvg === "original" ? "alternative" : "original");
    
    const el = document.createElement("textarea");
    el.value = link;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  };

  const copy_code_second_time = () => {
    const el = document.createElement("textarea");
    el.value = link;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);

    alert("Code was suceccfuly copied again.");
  }

  return (
    <Box sx={{ 
      backgroundColor: '#F1F1F1',
      borderRadius: '8px',
      padding: '15px',
      position: 'relative',
      color: 'black',
      mb: [4],
      
    }}>
      <Box sx={{ 
          display: 'flex', 
          justifyContent: 'space-between',
          alignItems: 'inital',
        }}>
          <Box sx={{ marginRight: '10px' }}>
            <div>{`<div`}</div>
            <div style={{marginLeft: '15px'}} >{`class="polis"`}</div>
            <div style={{marginLeft: '15px'}}>{`data-page_id="PAGE_ID" `}</div>
            <div style={{marginLeft: '15px'}}>{`data-site_id="polis_site_id_4YL6dwybMhGVEBqpXv"> `}</div>
            <div>{`</div>`}</div>
            <div>{link}</div>
          
            
          </Box>
          {currentSvg === "original" ?
          <svg onClick={copy_link_poli} xmlns="http://www.w3.org/2000/svg" width="27" height="34" viewBox="0 0 27 34" fill="none">
           <path d="M9 11.3334V7.36671C9 5.77989 9 4.98648 9.24524 4.3804C9.46095 3.84728 9.80516 3.41383 10.2285 3.14219C10.7098 2.83337 11.3399 2.83337 12.6 2.83337H21.15C22.4101 2.83337 23.0402 2.83337 23.5215 3.14219C23.9448 3.41383 24.289 3.84728 24.5048 4.3804C24.75 4.98648 24.75 5.77989 24.75 7.36671V18.1334C24.75 19.7202 24.75 20.5136 24.5048 21.1197C24.289 21.6528 23.9448 22.0863 23.5215 22.3579C23.0402 22.6667 22.4101 22.6667 21.15 22.6667H18M5.85 31.1667H14.4C15.6601 31.1667 16.2902 31.1667 16.7715 30.8579C17.1948 30.5863 17.539 30.1528 17.7548 29.6197C18 29.0136 18 28.2202 18 26.6334V15.8667C18 14.2799 18 13.4865 17.7548 12.8804C17.539 12.3473 17.1948 11.9138 16.7715 11.6422C16.2902 11.3334 15.6601 11.3334 14.4 11.3334H5.85C4.58988 11.3334 3.95982 11.3334 3.47852 11.6422C3.05516 11.9138 2.71095 12.3473 2.49524 12.8804C2.25 13.4865 2.25 14.2799 2.25 15.8667V26.6334C2.25 28.2202 2.25 29.0136 2.49524 29.6197C2.71095 30.1528 3.05516 30.5863 3.47852 30.8579C3.95982 31.1667 4.58988 31.1667 5.85 31.1667Z" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          :
          <svg onClick={copy_code_second_time}  xmlns="http://www.w3.org/2000/svg" width="27" height="35" viewBox="0 0 27 35" fill="none">
            <path d="M5.625 18.9584L10.125 24.7917L21.375 10.2084" stroke="#545F71" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>}
        </Box>
    </Box>
  );
};

export default Integrate