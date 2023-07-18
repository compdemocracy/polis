/** @jsx jsx */

import React, { useState } from "react";
import { Flex, Box, Text, Button, Image, jsx } from "theme-ui";
import anon_profile from "./anon_profile";

const StatementForm = ({ myAvatar }) => {
  const [charCount, setCharCount] = useState(0);

  return (
    <Flex sx={{ columnGap: "10px" }}>
      <Box sx={{ flex: "0 0 auto" }}>
        <Image
          sx={{ variant: "borders.avatar" }}
          width="35"
          height="35"
          src={myAvatar || anon_profile}
        />
      </Box>
      <Box sx={{ flex: "0 1 100%" }}>
        <form sx={{ mb: [2] }}>
          <textarea
            sx={{
              variant: "borders.primary",
              fontFamily: "body",
              fontSize: [2],
              width: "100%",
              padding: [2],
              resize: "none",
            }}
            id="createStatement"
            placeholder="Share your perspective..."
            type="text"
            onChange={(event) => setCharCount(event.target.value.length)}
            maxLength={400}
          />
          <Flex sx={{ alignItems: "center", justifyContent: "end" }}>
            {charCount > 140 ? (
              <Text sx={{ color: "red", mr: [3] }}>{`Statement length limit exceeded by ${
                charCount - 140
              } ${charCount - 140 > 1 ? "characters" : "character"}`}</Text>
            ) : (
              <Text sx={{ color: "gray", mr: [3] }}>{140 - charCount}</Text>
            )}
            <Button sx={{ padding: "8px 28px", my: [1] }} id="submitButton">
              {"Submit"}
            </Button>
          </Flex>
        </form>
      </Box>
    </Flex>
  );
};

export default StatementForm;
