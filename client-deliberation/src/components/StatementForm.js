/** @jsx jsx */

import React, { useState } from "react";
import { Flex, Box, Text, Button, Image, jsx } from "theme-ui";
import anon_profile from "./anon_profile";

const StatementForm = ({ myAvatar }) => {
  const FORM_CHARACTER_LIMIT = 140;

  const [textValue, setTextValue] = useState("");
  const [charCount, setCharCount] = useState(0);
  const [showWarning, setShowWarning] = useState(false);
  const [warningMessage, setWarningMessage] = useState("");

  const submitComment = () => {
    console.log("submitting comment now");
    console.log("SUBMITTING TEXT: ", textValue);
    if (textValue.length === 0) {
      setWarningMessage("There was an error submitting your statement - Statement should not be empty.")
      setShowWarning(true)
    } else if (textValue.length > 140) {
      setWarningMessage("There was an error submitting your statement - Statement is too long.")
      setShowWarning(true)
    } else {
      
    }
  };

  const WarningMessage = () => {
    return (<Text sx={{ color: "white" }}>{warningMessage}</Text>)
  };

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
            onChange={(event) => {
              setTextValue(event.target.value);
              setCharCount(event.target.value.length);
            }}
            maxLength={400}
          />
          <Flex sx={{ alignItems: "center", justifyContent: "end" }}>
            {charCount > FORM_CHARACTER_LIMIT ? (
              <Text sx={{ color: "red", mr: [3] }}>{`Statement length limit exceeded by ${
                charCount - FORM_CHARACTER_LIMIT
              } ${charCount - FORM_CHARACTER_LIMIT > 1 ? "characters" : "character"}`}</Text>
            ) : (
              <Text sx={{ color: "gray", mr: [3] }}>{FORM_CHARACTER_LIMIT - charCount}</Text>
            )}
            <Button
              sx={{ padding: "8px 28px", my: [1], flex: "0 0 auto" }}
              id="submitButton"
              type="button"
              onClick={submitComment}
            >
              {"Submit"}
            </Button>
          </Flex>
          {showWarning && <Box sx={{flex: "0 1 auto", bg: "#cf152a", borderRadius: "5px", padding: "5px"}}><WarningMessage /></Box>}
        </form>
      </Box>
    </Flex>
  );
};

export default StatementForm;
