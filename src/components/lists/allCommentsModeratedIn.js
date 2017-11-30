import React from "react";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";

const allCommentsModeratedIn = ({conversation, comments, ptptCount, formatTid, math}) => {
  if (!conversation) {
    return <div>Loading allCommentsModeratedIn...</div>
  }

  return (
    <div>
      <p style={globals.primaryHeading}> All comments (excluding those moderated out) </p>
      <p style={globals.paragraph}>
        How groups voted across all comments
      </p>
      <div style={{marginTop: 50}}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={_.map(comments, (comment) => comment.tid).sort((a, b) => a - b)}
          comments={comments}/>
      </div>
    </div>
  );
};

export default allCommentsModeratedIn;
