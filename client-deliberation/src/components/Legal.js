import React, { useState, useEffect } from "react";
import { Box, Button } from "theme-ui";
import HexLogo from "./hexLogo";
import Title from "./Title";

import { MDXProvider } from "@theme-ui/mdx";
import IndividualDeliberationMD from "./IndividualDeliberationMD.mdx"
import IntegrateLink from "./IntegrateLink";
import IntegrateBox from "./IntegrateBox";
import Tutorial from "./Tutorial";


const Legal = () => {

  const items = [
    "Keeps Your Information Private: AI often uses information from people to learn and work better. However, there are rules to make sure this information is kept secret and safe, so no one can use it in a way that harms or is unfair to others. This is like keeping your secrets safe!",
    "Decides Ownership of AI Creations: Sometimes AI can create new things, like a drawing or a piece of music. The rules help decide who the creation belongs to - whether it's the person who made the AI, the AI itself, or someone else. It's like figuring out who gets to keep a painting after it's done!",
    "Figures Out Who Says Sorry for Mistakes: If AI makes a mistake or does something wrong, the rules help figure out who should take responsibility and fix the problem. This ensures that if something goes wrong, there's a way to make things right again.",
    "Makes Clear and Fair Rules for AI Use: The rules are designed to be easy to understand and fair to everyone. This means that whether you're someone who uses AI or someone who creates AI, you'll know what you can and can't do, ensuring everyone plays fairly and safely in the AI playground!",
  ];

  const videoStyles = {
    display: 'flex',
    justifyContent: 'center',
    margin: '20px',
    
  };

  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px"}}>
      <HexLogo />
      <Title value={"Legal topics of AI"} />
      
      <div style={{...videoStyles, display: 'flex', justifyContent: 'center', margin: '20px'}}>
      <iframe width="560" height="315" src="https://www.youtube.com/embed/J7wgpVbZaLc?si=mCFAVhV4lQVHYAxX" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
      
      <IntegrateBox heading={"Easy explanation"} description={'AI has rules to follow, like keeping your information private and deciding who owns the things it creates. Sometimes its tricky to know who should say sorry if AI makes a mistake. People who understand laws are working hard to make clear rules for AI to ensure its fair and safe for everyone.'} ></IntegrateBox>


      <IntegrateBox heading={"How inputdata shapes AI"} description={'AI has specific legal rules to ensure it works well for everyone:'} items={items} ></IntegrateBox>
     
    </Box>
  );
};

export default Legal;
