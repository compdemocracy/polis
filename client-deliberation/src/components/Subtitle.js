import React from "react";
import { Heading } from "theme-ui";

const Subtitle = ({ value }) => {
  return (
    <Heading
      as="h2"
      sx={{
        fontSize: [2],
        fontWeight: 300,
        lineHeight: "body",
        mb: [3, null, 4],
      }}
    >
      {value}
    </Heading>
  );
};

export default Subtitle;
