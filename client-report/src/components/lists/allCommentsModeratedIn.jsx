// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState } from "react";
import CommentList from "./commentList.jsx";
import * as globals from "../globals";


const sortFunctions = {
  tid: (comments) => comments.sort((a, b) => a.tid - b.tid).map(c => c.tid),
  numvotes: (comments) => comments.sort((a, b) => b.count - a.count).map(c => c.tid), // Descending order for numvotes
  consensus: (comments) => comments.sort((a, b) => b["group-aware-consensus"] - a["group-aware-consensus"]).map(c => c.tid),
  pctAgreed: (comments) => comments.sort((a, b) => b["pctAgreed"] - a["pctAgreed"]).map(c => c.tid),
  pctDisagreed: (comments) => comments.sort((a, b) => b["pctDisagreed"] - a["pctDisagreed"]).map(c => c.tid),
  pctPassed: (comments) => comments.sort((a, b) => b["pctPassed"] - a["pctPassed"]).map(c => c.tid),
};

const allCommentsModeratedIn = ({ conversation, ptptCount, math, formatTid, comments, voteColors }) => {

  const [sortStyle, setSortStyle] = useState(globals.allCommentsSortDefault)

  const onSortChanged = (event) => {
    setSortStyle(event.target.value)
  };


  if (!conversation) {
    return <div>Loading allCommentsModeratedIn...</div>
  }

  const sortFunction = sortFunctions[sortStyle] || sortFunctions["tid"];

  return (
    <div>
      <p style={globals.primaryHeading}> All statements </p>
      <p style={globals.paragraph}>
        Group votes across all statements, excluding those statements which were moderated out.
      </p>
      <label htmlFor="allCommentsSortMode">Sort by: </label>
      <select id="allCommentsSortMode" onChange={onSortChanged} value={sortStyle}>
        <option value="tid">Statement Id</option>
        <option value="consensus">Group-informed Consensus</option>
        <option value="numvotes">Number of votes</option>
        <option value="pctAgreed">% Agreed</option>
        <option value="pctDisagreed">% Disagreed</option>
        <option value="pctPassed">% Passed</option>
      </select>
      <div style={{marginTop: 50}}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={sortFunction(comments)}
          comments={comments}
          voteColors={voteColors}/>
      </div>
    </div>
  );
}

export default allCommentsModeratedIn;
