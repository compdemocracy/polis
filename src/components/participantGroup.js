import React from "react";
import Comment from "./participantGroupComment";
import * as globals from "./globals";
import Flex from "./flex"
import style from "../util/style";

const ParticipantGroup = ({repnessIndex, groupComments, conversation, allComments, groupVotesForThisGroup, demographicsForGroup, ptptCount}) => {

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
        groupVotesForThisGroup={groupVotesForThisGroup}
        ptptCount={ptptCount}/>

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
                 • <span style={style.variable}>{groupVotesForThisGroup["n-members"]}</span> participants
              </span>
            </span>
            <div style={{
              paddingBottom: "10px",
            }}>
            In this group, <span style={style.variable}>{demo.count}</span> ptpts have demographic data. Of those,
              <span style={style.variable}>{demo.gender_male}</span> are <span style={style.metadataCategory}>male</span>, <span style={style.variable}>{demo.gender_female}</span> are <span style={style.metadataCategory}>female</span>, <span style={style.variable}>{demo.gender_null}</span> <span style={style.metadataCategory}>unknown</span>.
              The average age is <span style={style.metadataCategory}>{Math.round(currentYear - demo.birth_year)}</span>.
            </div>
          </div>
          <span
            style={{
              width: globals.barChartWidth,
              position: "relative",
              left: 40
            }}>
            All (<span style={style.variable}>{ptptCount}</span>)
          </span>
          <span
            style={{
              width: globals.barChartWidth,
              position: "relative",
              left: 40
            }}>
            This group (<span style={style.variable}>{groupVotesForThisGroup["n-members"]}</span>)
          </span>
        </Flex>
      {drawGroupComments(groupVotesForThisGroup)}
    </div>
  );
};

export default ParticipantGroup;
