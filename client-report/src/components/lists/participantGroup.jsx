// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import * as globals from "../globals.js";
import CommentList from "./commentList.jsx";

const ParticipantGroup = ({
  gid,
  groupComments,
  conversation,
  comments,
  groupVotesForThisGroup,
  ptptCount,
  groupName,
  formatTid,
  math,
  voteColors,
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
      <p style={globals.paragraph}> Statements which make this group unique, by their votes: </p>
      <CommentList
        conversation={conversation}
        ptptCount={ptptCount}
        math={math}
        formatTid={formatTid}
        tidsToRender={groupComments.map(c => c.tid)}
        comments={comments}
        voteColors={voteColors}/>
    </div>
  );
};

export default ParticipantGroup;
