import React from "react";
import * as globals from "../globals";
import Flex from "../framework/flex"
import style from "../../util/style";
import CommentList from "./commentList";

const ParticipantGroup = ({
  gid,
  groupComments,
  conversation,
  comments,
  groupVotesForThisGroup,
  groupVotesForOtherGroups,
  demographicsForGroup,
  ptptCount,
  groupName,
  formatTid,
  groupNames,
  math,
}) => {

  let groupLabel = groupName;
  if (typeof groupLabel === "undefined") {
    groupLabel = "Group " + globals.groupLabels[gid];
  }

  return (
    <div
      style={{
        width: "100%",
      }}>
      <p style={globals.secondaryHeading}>
        {groupLabel}: {groupVotesForThisGroup["n-members"]} participants
      </p>
      <p style={globals.paragraph}> Comments which make this group unique, by their votes: </p>
      <CommentList
        conversation={conversation}
        ptptCount={ptptCount}
        math={math}
        formatTid={formatTid}
        tidsToRender={_.map(groupComments, 'tid') /* uncertainTids would be funnier */}
        comments={comments}/>




    </div>
  );
};

export default ParticipantGroup;
