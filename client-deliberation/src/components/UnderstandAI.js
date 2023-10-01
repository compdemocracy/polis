import React, { useState, useEffect } from "react";
import { Box, Button } from "theme-ui";
import HexLogo from "./hexLogo";
import Title from "./Title";

import { MDXProvider } from "@theme-ui/mdx";
import IndividualDeliberationMD from "./IndividualDeliberationMD.mdx"
import IntegrateLink from "./IntegrateLink";
import IntegrateBox from "./IntegrateBox";
import Tutorial from "./Tutorial";


const UnderstandAI = () => {

  const items = [
    "Quality of Data: If the data is accurate and diverse, the AI becomes more reliable and understands a broader range of information, just like using fresh and varied ingredients makes a tastier cake.",
    "Bias in Data: If the data contains biases (unfair preferences or dislikes), the AI might develop biased views and make unfair decisions. It's like if a recipe is written with too much of one ingredient, the cake might not taste right.",
    "Volume of Data: More data helps the AI learn better, similar to how following a recipe with detailed steps and tips can help you bake a better cake. Without enough data, AI might not perform well because it hasn’t “seen” or “learned” enough.",
    "Rules and Algorithms: The rules and algorithms guiding the AI are like the cooking instructions for the cake. If they are clear and well-designed, the AI can process data efficiently and make smart decisions.",
    "Feedback Loop: Continuous learning from new data and feedback helps AI improve over time, akin to tweaking and refining a recipe after each attempt to get the perfect cake.",
  ];

  const videoStyles = {
    display: 'flex',
    justifyContent: 'center',
    margin: '20px',
    
  };

  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px"}}>
      <HexLogo />
      <Title value={"Understand AI"} />
      
      <div style={{...videoStyles, display: 'flex', justifyContent: 'center', margin: '20px'}}>
      <iframe width="560" height="315" src="https://www.youtube.com/embed/R9OHn5ZF4Uo?si=7z2akiELGhjCaO1R" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
      
      <IntegrateBox heading={"Easy explanation"} description={'Imagine AI, or Artificial Intelligence, is like a robot brain inside computers, phones, or even toys. This robot brain can think, learn, and solve problems, almost like how you do in school! AI helps devices understand and respond to what you say or do, making them smarter and more helpful. For example, when you talk to a toy or phone, and it talks back or follows your commands, that’s AI working! 🤖🧠'} ></IntegrateBox>


      <IntegrateBox heading={"How inputdata shapes AI"} description={'Input data and rules significantly shape an AIs learning and behavior, much like how ingredients and a recipe determine a cake’s taste and texture.'} items={items} ></IntegrateBox>

    </Box>
  );
};

export default UnderstandAI;
