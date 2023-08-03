import React, { useState, useEffect } from "react";
import Title from "./Title";
import Subtitle from "./Subtitle";
import StatementUIContainer from "./StatementUIContainer";
import StatementUI from "./StatementUI";
import StatementForm from "./StatementForm";
import { Flex, Box, Text } from "theme-ui";
import HexLogo from "./hexLogo";
import OpinionContainer from "./OpinionContainer";
import PolisNet from "../util/net";

const ConversationUI = (props) => {
  const conversation_id = props.match.params.conversation_id;
  const [nextComment, setNextComment] = useState(props.response.nextComment);

  const vote = (params) => {
    PolisNet.polisPost(
      "/api/v3/votes",
      $.extend({}, params, {
        pid: "mypid",
        conversation_id: conversation_id,
        agid: 1,
        tid: nextComment.tid,
        weight: 0,
      }),
    )
      .then((res) => {
        if (res.nextComment === undefined && res.currentPid !== undefined) {
            // for correctly showing "you've voted on all statements" message
            setNextComment({currentPid: res.currentPid})
        } else {
          setNextComment(res.nextComment);
        }
        if (!_.isUndefined(res.currentPid)) {
          processPidResponse(res.currentPid);
        }
      })
      .fail((err) => {
        if (!navigator.cookieEnabled) {
          alert(
            "Sorry, voting requires cookies to be enabled. If you do enable cookies, be sure to reload the page after.",
          );
        } else {
          alert("Apologies, your vote failed to send. Please check your connection and try again.");
        }
      });
  };

  // useEffect(() => {
  //   PolisNet.polisGet("/api/v3/participationInit", {
  //     conversation_id: conversation_id,
  //     pid: "mypid",
  //     lang: "acceptLang",
  //   }).then((res) => {
  //     setNextComment(res.nextComment);
  //   });
  // }, []);

  return (
    <Box sx={{ maxWidth: "768px", margin: "auto", py: "20px", px: "10px" }}>
      <HexLogo />
      <Title value={props.response.conversation.topic} />
      <Subtitle value={props.response.conversation.description} />
      <Text variant="conversationPage" sx={{ mb: [2] }}>
        Welcome to a new kind of conversation - vote on other people's statements.
      </Text>
      <Box sx={{ mb: "-40px" }}>
        <StatementUIContainer>
          {typeof nextComment !== "undefined" && nextComment.hasOwnProperty("tid") ? (
            <StatementUI
              author="Anonymous"
              numStatementsRemaining={nextComment.remaining}
              statement={nextComment.txt}
              vote={vote}
            />
          ) : (
            <Text>
              You've voted on all the statements. Feel free to leave your own comments below!
            </Text>
          )}
        </StatementUIContainer>
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
      <Text variant="conversationPage" sx={{ mb: [3] }}>
        Are your perspectives or experiences missing from the conversation? If so, add them in the
        box below.
      </Text>
      <Text variant="conversationPage">What makes a good statement?</Text>
      <Text variant="conversationPage">
        <ul>
          <li>Stand alone idea</li>
          <li>Raise new perspectives, experiences or issues</li>
          <li>Clear & concise (limited to 140 characters)</li>
        </ul>
      </Text>
      <Text variant="conversationPage" sx={{ mb: [3] }}>
        Please remember, statements are displayed randomly and you are not replying directly to
        other participants' statements.
      </Text>
      <StatementForm conversation_id={conversation_id} />
      <Box sx={{ mb: [5] }}>
        <OpinionContainer />
      </Box>
      <Flex sx={{ justifyContent: "center" }}>
        {/* TODO: enlarge */}
        <HexLogo />
      </Flex>
    </Box>
  );
};

export default ConversationUI;
