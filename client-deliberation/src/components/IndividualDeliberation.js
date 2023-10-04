import React, { useState, useEffect } from "react";
import { Box, Button } from "theme-ui";
import HexLogo from "./hexLogo";
import Title from "./Title";

import { MDXProvider } from "@theme-ui/mdx";
import IndividualDeliberationMD from "./IndividualDeliberationMD.mdx"
import IntegrateLink from "./IntegrateLink";
import IntegrateBox from "./IntegrateBox";
import Tutorial from "./Tutorial";


const IndividualDeliberation = (props = {}) => {

  const [currentIndex, setCurrentIndex] = useState(0);

  const items = [
    "When this embed code loads on your website, it will either create a new conversation (if one is not already associated with the string passed into PAGE_ID) or load an existing conversation.",
    "This embed code will keep track of what conversations belongs on what pages via the data-page_id HTML attribute.",
    "Simply replace \"PAGE_ID\", either manually or in your templates, to create new conversations and load existing ones in the right place."
  ];

  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    if (currentIndex === 1 && !zoom) {
      setZoom(true); 
      setTimeout(() => {
        setZoom(false); 
      }, 500);
    }
  }, [currentIndex]);

  const videoStyles = {
    display: 'flex',
    justifyContent: 'center',
    margin: '20px',
    transform: zoom && currentIndex === 1 ? 'scale(1.2)' : 'scale(1)',
    transition: 'transform 0.5s',
    
  };

  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px"}}>
      <HexLogo />
      <Title value={"Individual Deliberation"} />
      
      <div style={{...videoStyles, display: 'flex', justifyContent: 'center', margin: '20px'}}>
      <iframe width="560" height="315" src="https://www.youtube.com/embed/NbEbs6I3eLw?si=PnsDmPiIMr9VY59V" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
      
      <IntegrateLink link={'<script async src="https://pol.is/embed.js"></script>'}></IntegrateLink>

      <IntegrateBox heading={"Integration Description"} description={'Copy and paste this code into your content management template. Each page (article, post) requires a unique string in the "PAGE_ID" field. This should be consistent over time and unique to each of your pages (like the article title).'} items={items} ></IntegrateBox>

      {
        !props.finishedTutorial &&
        <Tutorial setCurrentIndex={setCurrentIndex} currentIndex={currentIndex} email={props}></Tutorial>
      }
    </Box>
  );
};

export default IndividualDeliberation;
