import React from "react";
import PropTypes from "prop-types";
import { Flex, Box, Text, Image } from "theme-ui";
import AgreeButton from "./AgreeButton";
import DisagreeButton from "./DisagreeButton";
import PassButton from "./PassButton";
import anon_profile from "./anon_profile";

const StatementUI = ({ author, authorAvatar, numStatementsRemaining, statement, vote }) => {
  return (
    <React.Fragment>
      <Flex
        sx={{
          columnGap: "10px",
        }}
      >
        <Box sx={{ flex: "0 0 auto" }}>
          <Image
            sx={{ variant: "borders.avatar" }}
            width="35"
            height="35"
            src={authorAvatar || anon_profile}
          />
        </Box>
        <Flex sx={{ flex: "1 1 auto", flexDirection: "column" }}>
          <Flex sx={{ justifyContent: "space-between" }}>
            <Text
              sx={{
                fontSize: [1, null, 2],
                fontWeight: "300",
              }}
            >
              {author} wrote:
            </Text>
            <Text sx={{ fontFamily: "Georgia", fontStyle: "italic", fontSize: [0] }}>
              {numStatementsRemaining} remaining
            </Text>
          </Flex>
          <Box sx={{ maxWidth: "85%", overflowWrap: "break-word" }}>
            <Text
              sx={{
                fontSize: [2, null, 3],
                lineHeight: "body",
                mb: [4, null, 3],
              }}
            >
              {statement}
            </Text>
          </Box>
        </Flex>
      </Flex>

      <Flex
        sx={{
          justifyContent: "space-around",
        }}
      >
        <AgreeButton vote={vote} />
        <DisagreeButton vote={vote} />
        <PassButton vote={vote}/>
      </Flex>
    </React.Fragment>
  );
};

StatementUI.propTypes = {
  author: PropTypes.string,
  authorAvatar: PropTypes.string,
  numStatementsRemaining: PropTypes.number,
  statement: PropTypes.string,
  vote: PropTypes.func,
};

export default StatementUI;
