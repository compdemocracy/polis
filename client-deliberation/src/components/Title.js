import React from "react";
import { Heading } from "theme-ui";

const Title = ({ value }) => {
  return (
    <Heading
      as="h1"
      sx={{
        fontSize: [4, null, 5],
        lineHeight: "body",
        mb: [3, null, 2],
      }}
    >
      {value}
    </Heading>
  );
};

export default Title;
