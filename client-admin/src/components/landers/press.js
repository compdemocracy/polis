import React from "react";
import { Box, Link, Heading } from "theme-ui";

const Press = () => {
  return (
    <Box>
      <Heading as="h3" sx={{ fontSize: [4], lineHeight: "body", my: [2, null, 3] }}>
        Read
      </Heading>
      <Box sx={{ mb: [4, null, 5], maxWidth: "35em" }}>
        Press coverage from{" "}
        <Link
          target="_blank"
          href="https://www.nytimes.com/2019/10/15/opinion/taiwan-digital-democracy.html"
        >
          The New York Times
        </Link>
        ,{" "}
        <Link
          target="_blank"
          href="https://www.technologyreview.com/2018/08/21/240284/the-simple-but-ingenious-system-taiwan-uses-to-crowdsource-its-laws/"
        >
          MIT Tech Review
        </Link>
        ,{" "}
        <Link target="_blank" href="https://www.wired.co.uk/article/taiwan-democracy-social-media">
          Wired
        </Link>
        ,{" "}
        <Link
          target="_blank"
          href="https://www.economist.com/open-future/2019/03/22/technology-and-political-will-can-create-better-governance"
        >
          The Economist
        </Link>
        ,{" "}
        <Link
          target="_blank"
          href="https://www.centreforpublicimpact.org/case-study/building-consensus-compromise-uber-taiwan/#evidence"
        >
          Center for Public Impact
        </Link>
        ,{" "}
        <Link target="_blank" href="https://civichall.org/civicist/vtaiwan-democracy-frontier/">
          Civicist
        </Link>
        ,{" and a mini documentary from "}
        <Link target="_blank" href="https://www.youtube.com/watch?v=VbCZvU7i7VY">
          BBC
        </Link>
      </Box>
    </Box>
  );
};

export default Press;

// <Card
// sx={{
//   borderRadius: "3",
//   boxShadow:
//     "0 8px 16px -4px rgba(0,0,0,.1), 0 0 8px -3px rgba(0,0,0,.1)",
// }}
// >
// <VTaiwan />
// <Box sx={{ p: "3" }}>
//   <Heading as="h2" mb={2}>
//     The New York Times
//   </Heading>
//   <Text>A Strong Democracy Is a Digital Democracy</Text>
// </Box>
// </Card>

// https://theme-ui-gallery.netlify.app/cards/
