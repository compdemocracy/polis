import React from "react";
import Title from "./Title";
import Subtitle from "./Subtitle";
import HexLogo from "./hexLogo";
import { Box, Spinner } from "theme-ui";

const Loading = () => {

  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px" }}>
      <HexLogo />
      <Box sx={{mt: 15}}>
        <Spinner />
      </Box>
    </Box>
  );
};

export default Loading;
