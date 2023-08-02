import React from "react";
import { Box } from "theme-ui";

const StatementUIContainer = (props) => {
  return (
    <Box sx={{ mb: "-40px" }}>
      <Box sx={{ variant: "statementBox" }}>
        <Box sx={{ margin: "10px" }}>{props.children}</Box>
      </Box>
      <Box
        sx={{
          variant: "statementBox.stack",
          width: "99%",
          top: "-26px",
          zIndex: "-1",
        }}
      />
      <Box
        sx={{
          variant: "statementBox.stack",
          width: "98%",
          top: "-52px",
          zIndex: "-2",
        }}
      />
    </Box>
  );
};

export default StatementUIContainer;
