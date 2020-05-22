import React from "react";
import Layout from "./layout";
import { Heading, Box, Text, Link } from "theme-ui";
import emoji from "react-easy-emoji";
import ExploreKnowledgeBase from "./exploreKnowledgeBase";
import Press from "./press";

const Index = () => {
  return (
    <Layout>
      <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
        Input Crowd, Output Meaning
      </Heading>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: "body",
          mb: [4, null, 5],
        }}
      >
        Polis is a real-time system for gathering, analyzing and understanding what large groups of
        people think in their own words, enabled by advanced statistics and machine learning.
      </Heading>
      <Box sx={{ mb: [4, null, 5] }}>
        <Text>
          Polis has been used all over the world by governments, academics, independent media and
          citizens, and is completely open source.
        </Text>
      </Box>
      <Heading as="h3" sx={{ fontSize: [4], lineHeight: "body", mb: [2, null, 3] }}>
        Get Started
      </Heading>
      <Box sx={{ mb: [4, null, 5] }}>
        <Link href="/createuser">Sign up</Link>
        {" or "}
        <Link href="/signin">Sign in</Link>
      </Box>
      <Press />
      <ExploreKnowledgeBase />
      <Heading as="h3" sx={{ fontSize: [4], lineHeight: "body", my: [2, null, 3] }}>
        Contribute
      </Heading>
      <Box sx={{ mb: [4, null, 5] }}>
        Explore the code and join the community{" "}
        <Link target="_blank" href="https://github.com/pol-is/">
          on Github
        </Link>
      </Box>
      <Heading as="h3" sx={{ fontSize: [4], lineHeight: "body", my: [2, null, 3] }}>
        Legal
      </Heading>
      <Box sx={{ mb: [2, null, 3], maxWidth: "30em" }}>
        Polis is built for the public with {emoji("❤️")} in Seattle {emoji("🇺🇸")}, with
        contributions from around the {emoji("🌍🌏🌎")}
      </Box>
      <Box sx={{ mb: [2, null, 3] }}>
        © {new Date().getFullYear()} The Authors{" "}
        <Link target="_blank" href="tos">
          TOS
        </Link>{" "}
        <Link target="_blank" href="privacy">
          Privacy
        </Link>
      </Box>
    </Layout>
  );
};

export default Index;
