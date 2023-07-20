import React from "react";
import { Box } from "theme-ui";

const StatementUIContainer = (props) => {
  return (
    <Box sx={{ variant: "statementBox" }}>
      <Box sx={{ margin: "10px" }}>{props.children}</Box>
    </Box>
  );
};

export default StatementUIContainer;
