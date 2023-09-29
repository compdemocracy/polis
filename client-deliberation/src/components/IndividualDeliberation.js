import React, { useState } from "react";
import { Box, Button } from "theme-ui";
import HexLogo from "./hexLogo";
import Title from "./Title";

import { MDXProvider } from "@theme-ui/mdx";
import IndividualDeliberationMD from "./IndividualDeliberationMD.mdx"
import IntegrateLink from "./IntegrateLink";


const IndividualDeliberation = () => {

  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px"}}>
      <HexLogo />
      <Title value={"Individual Deliberation"} />
      
      <div style={{display: 'flex', justifyContent: 'center', margin: '20px'}}>
      <iframe width="560" height="315" src="https://www.youtube.com/embed/NbEbs6I3eLw?si=PnsDmPiIMr9VY59V" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
      
      <IntegrateLink link={'<script async src="https://pol.is/embed.js"></script>'}></IntegrateLink>

      <Box sx={{ 
        backgroundColor: '#F1F1F1',
        borderRadius: '8px',
        padding: '15px',
        position: 'relative',
        color: 'black',
        mb: [4],
        
      }}>
         <h2 style={{marginTop: '0px', marginBottom: '10px',}}>Integration Description</h2>
        <Box sx={{ 
            display: 'flex', 
            justifyContent: 'space-between',
            alignItems: 'inital',
          }}>
            <Box sx={{ marginRight: '10px' }}>
              <div>{`Copy and paste this code into your content management template. Each page (article, post) requires a unique string in the "PAGE_ID" field. This should be consistent over time and unique to each of your pages (like the article title).`}</div>
             <ul>
                <li>When this embed code loads on your website, it will either create a new conversation (if one is not already associated with the string passed into PAGE_ID) or load an existing conversation.
                </li>
                <li>This embed code will keep track of what conversations belongs on what pages via the data-page_id HTML attribute.</li>
                <li>Simply replace "PAGE_ID", either manually or in your templates, to create new conversations and load existing ones in the right place.</li>
             </ul>
            </Box>
        
          </Box>
      </Box>

  
{/* 
     <Integrate></Integrate> */}
    </Box>
  );
};

export default IndividualDeliberation;
