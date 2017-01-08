import React from "react";
import Comment from "./participantGroupComment";
import * as globals from "./globals";
import Flex from "./flex"

const ParticipantGroup = ({repnessIndex, groupComments, conversation, allComments, groupVotesForThisGroup, demographicsForGroup}) => {

  const drawGroupComments = () => {
    const allCommentsKeyed = _.keyBy(allComments, "tid");

    return groupComments.map((c, i) => {
      // const groupVotes = math["group-votes"][repnessIndex].votes[comment.tid];
      // const isBestAgree = comment["best-agree"] && (groupVotes && groupVotes.A > 0);
      // const agree = isBestAgree || comment["repful-for"] === "agree";
      // const percent = agree ?
      // Math.floor(groupVotes.A / groupVotes.S * 100) :
      // Math.floor(groupVotes.D / groupVotes.S * 100);

      return <Comment
        conversation={conversation}
        key={i}
        index={i}
        comment={allCommentsKeyed[c.tid]}
        groupVotesForThisGroup={groupVotesForThisGroup} />

    })
  }

  let demo = demographicsForGroup;
  let currentYear = (new Date()).getUTCFullYear();

  return (
    <div
      style={{
        marginBottom: 70,
        width: "100%"
      }}>
        <Flex justifyContent={"flex-start"} styleOverrides={{width: "100%"}}>
          <div style={{
              width: globals.paragraphWidth
            }}>
            <span style={{fontSize: 18}}>
              {`GROUP ${+repnessIndex + 1} `}
              <span style={{fontSize: 18}}>
                {` • ${groupVotesForThisGroup["n-members"]} participants`}
              </span>
            </span>
            <div style={{
              paddingBottom: "10px",
            }}>
            {`In this group, ${demo.count} ptpts have demographic data. Of those,
              ${demo.gender_male} are male, ${demo.gender_female} are female, ${demo.gender_null} unknown.
              The average age is ${Math.round(currentYear - demo.birth_year)}.`}
            </div>
          </div>
          <span
            style={{
              width: globals.barChartWidth,
              position: "relative",
              left: 40
            }}>
            All ({conversation.participant_count})
          </span>
          <span
            style={{
              width: globals.barChartWidth,
              position: "relative",
              left: 40
            }}>
            This group ({groupVotesForThisGroup["n-members"]})
          </span>
        </Flex>
      {drawGroupComments(groupVotesForThisGroup)}
    </div>
  );
};

export default ParticipantGroup;
