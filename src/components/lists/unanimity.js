import React from "react";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";

const Unanimity = ({conversation, comments, ptptCount, unanimity, formatTid, math, voteColors}) => {

  if (!conversation) {
    return <div>Loading Unanimity...</div>
  }

  if (conversation && unanimity.length === 0) {
    return null
  }

  return (
    <div>
      <p style={globals.primaryHeading}> Consensus </p>
      <p style={globals.paragraph}>
        There was absolute agreement on the following statements, across all participants and groups.
      </p>
      <div style={{marginTop: 50}}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={unanimity /* uncertainTids would be funnier */}
          comments={comments}
          voteColors={voteColors}/>
      </div>
    </div>
  );
};

export default Unanimity;
