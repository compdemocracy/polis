/** @jsx jsx */

import React, { useState, useEffect } from "react";
import { Flex, Box, Text, Button, Image, jsx } from "theme-ui";
import anon_profile from "./anon_profile";
import PolisNet from "../util/net";

const StatementForm = ({ myAvatar, conversation_id }) => {
  const FORM_CHARACTER_LIMIT = 140;

  const [textValue, setTextValue] = useState("");
  const [showMessage, setShowMessage] = useState({ show: false, status: null });
  const [messageValue, setMessageValue] = useState("");

  useEffect(() => {
    setShowMessage({ show: false, status: null });
  }, [textValue]);

  const submitComment = () => {
    if (textValue.length === 0) {
      setMessageValue(
        "There was an error submitting your statement - Statement should not be empty.",
      );
      setShowMessage({ show: true, status: "failure" });
    } else if (textValue.length > 140) {
      setMessageValue("There was an error submitting your statement - Statement is too long.");
      setShowMessage({ show: true, status: "failure" });
    } else {
      // replace newlines with whitespace
      const txt = textValue.replace(/\n/g, " ");

      PolisNet.polisPost("/api/v3/comments", {
        conversation_id: conversation_id,
        agid: 1,
        txt: txt,
      })
        .then((res) => {
          setTextValue("");
          setMessageValue(
            "Statement submitted! Only other participants will see your statement and agree or disagree.",
          );
          setShowMessage({ show: true, status: "success" });
        })
        .fail((err) => {
          if (err.status === 409) {
            setMessageValue(
              "There was an error submitting your statement - An identical statement already exists.",
            );
            setShowMessage({ show: true, status: "failure" });
          } else if (err.responseText === "polis_err_conversation_is_closed") {
            setMessageValue("This conversation is closed. No further statements can be submitted.");
          } else {
            setMessageValue("There was an error submitting your statement.");
          }
        });
    }
  };

  const Message = () => {
    return (
      <Flex
        sx={{
          justifyContent: "flex-end",
        }}
      >
        <Box
          sx={{
            bg: `${showMessage.status === "success" ? "#32a852" : "#cf152a"}`,
            borderRadius: "5px",
            padding: "5px",
          }}
        >
          <Text sx={{ color: "white" }}>{messageValue}</Text>
        </Box>
      </Flex>
    );
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
            value={textValue}
            onChange={(event) => {
              setTextValue(event.target.value);
            }}
            maxLength={400}
          />
          <Flex sx={{ alignItems: "center", justifyContent: "end" }}>
            {textValue.length > FORM_CHARACTER_LIMIT ? (
              <Text sx={{ color: "red", mr: [3] }}>{`Statement length limit exceeded by ${
                textValue.length - FORM_CHARACTER_LIMIT
              } ${textValue.length - FORM_CHARACTER_LIMIT > 1 ? "characters" : "character"}`}</Text>
            ) : (
              <Text sx={{ color: "gray", mr: [3] }}>{FORM_CHARACTER_LIMIT - textValue.length}</Text>
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
          {showMessage.show && <Message />}
        </form>
      </Box>
    </Flex>
  );
};

export default StatementForm;
