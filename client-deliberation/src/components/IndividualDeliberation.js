import React from "react";
import { Box, Text } from "theme-ui";
import HexLogo from "./hexLogo";
import Title from "./Title";

import { MDXProvider } from "@theme-ui/mdx";
import IndividualDeliberationMD from "./IndividualDeliberationMD.mdx"

const IndividualDeliberation = () => {
  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px" }}>
      <HexLogo />
      <Title value={"Individual Deliberation"} />
      <MDXProvider>
        <IndividualDeliberationMD/>
      </MDXProvider>
    </Box>
  );
};

export default IndividualDeliberation;
