import React from "react";
import Comment from "./participantGroupComment";
import Graph from "./Graph";
import MetadataComments from "./participantGroupMetadataComments";
import * as globals from "./globals";
import Flex from "./flex"
import style from "../util/style";

const ParticipantGroup = ({
  gid,
  groupComments,
  conversation,
  allComments,
  groupVotesForThisGroup,
  groupVotesForOtherGroups,
  demographicsForGroup,
  ptptCount,
  groupName,
  formatTid,
  groupNames,
  badTids,
  repfulAgreeTidsByGroup,
  repfulDisageeTidsByGroup,
  math,
  report,
}) => {

  const drawGroupComments = () => {
    const allCommentsKeyed = _.keyBy(allComments, "tid");

    return groupComments.map((c, i) => {
      if (!allCommentsKeyed[c.tid]) {
        console.log('modded out?', c.tid);
        return "";
      }
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
          marginBottom: 20,
          fontSize: globals.secondaryHeading
        }}>
        <p style={globals.paragraph}>
          {groupName}
        </p>
        <svg width="1.4em"height="1.4em" style={{border: "none", marginRight: 10, position: "relative", top: 5}}>
          <circle
            r={10}
            fill={globals.groupColor(gid)}
            cx={12}
            cy={12}/>
        </svg>
        <span style={{fontSize: 24, color: globals.groupColor(gid)}}>{groupVotesForThisGroup["n-members"]} PARTICIPANTS</span>
        <MetadataComments
          allComments={allComments}
          conversation={conversation}
          formatTid={formatTid}
          ptptCount={ptptCount}
          demographicsForGroup={demographicsForGroup}/>
      </div>
      <Graph
        comments={allComments}
        groupNames={groupNames}
        badTids={badTids}
        formatTid={formatTid}
        repfulAgreeTidsByGroup={repfulAgreeTidsByGroup}
        repfulDisageeTidsByGroup={repfulDisageeTidsByGroup}
        showOnlyGroup={gid}
        math={math}
        report={report}/>
      <Flex justifyContent={"flex-start"} alignItems={"baseline"} styleOverrides={{width: "100%", marginBottom: 40}}>
        <div style={globals.paragraph}>

        </div>
        <span
          style={{
            width: globals.barChartWidth,
            position: "relative",
            left: 40
          }}>
          This Group ({groupVotesForThisGroup["n-members"]})
        </span>
        <span
          style={{
            width: globals.barChartWidth,
            position: "relative",
            left: 40
          }}>
          All Others ({groupVotesForOtherGroups["n-members"]})
        </span>
      </Flex>
      {drawGroupComments(groupVotesForThisGroup)}

    </div>
  );
};

export default ParticipantGroup;

// <p>Metadata Comments</p>
// {drawGroupMetadataComments()}
