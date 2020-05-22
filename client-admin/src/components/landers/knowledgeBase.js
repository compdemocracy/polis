import React from "react";
import { Box, Link, Styled } from "theme-ui";
import emoji from "react-easy-emoji";

const KnowledgeBase = ({ e, url, txt }) => {
  return (
    <Box sx={{ my: [3] }}>
      <Link target="_blank" href={url}>
        <span style={{ marginRight: 12 }}>{emoji(e)}</span>
        {txt}
      </Link>
    </Box>
  );
};

export default KnowledgeBase;
