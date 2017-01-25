import React from "react";
import Comment from "./participantGroupComment";
import * as globals from "./globals";
import Flex from "./flex"
import style from "../util/style";

const ParticipantGroup = ({gid, groupComments, conversation, allComments, groupVotesForThisGroup, groupVotesForOtherGroups, demographicsForGroup, ptptCount, groupName, formatTid}) => {

  const drawGroupComments = () => {
    const allCommentsKeyed = _.keyBy(allComments, "tid");

    return groupComments.map((c, i) => {
      // const groupVotes = math["group-votes"][gid].votes[comment.tid];
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
        formatTid={formatTid}
        groupVotesForThisGroup={groupVotesForThisGroup}
        groupVotesForOtherGroups={groupVotesForOtherGroups}
        ptptCount={ptptCount}/>

    })
  }

  let demo = demographicsForGroup;
  let currentYear = (new Date()).getUTCFullYear();

  return (
    <div
      style={{
        marginBottom: 20,
        width: "100%",

      }}>
      <div style={{
          width: globals.paragraphWidth,
          fontWeight: 700,
          marginBottom: 20,
          fontSize: globals.secondaryHeading
        }}>
        <span>
          {`GROUP ${gid + 1} `}
          <span>
            • "{groupName}"
          </span>
          <svg width="1em"height="1em" style={{border: "none"}}>
            <circle
              r={6}
              fill={globals.groupColor(gid)}
              cx={10}
              cy={10}/>
          </svg>
        </span>
        <div>{groupVotesForThisGroup["n-members"]} PARTICIPANTS</div>
      </div>
        <Flex justifyContent={"flex-start"} alignItems={"baseline"} styleOverrides={{width: "100%", marginBottom: 20}}>
          <div style={globals.paragraph}>
            In this group, {demo.count} participants have demographic data.
            Of those, {demo.gender_male} are male, {demo.gender_female} are female, {demo.gender_null} unknown.
            The average age is {Math.round(currentYear - demo.birth_year)}.
          </div>
          <span
            style={{
              width: globals.barChartWidth,
              position: "relative",
              left: 40
            }}>
            Other Groups ({groupVotesForOtherGroups["n-members"]})
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
