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
      <p style={globals.primaryHeading}> All comments </p>
      <p style={globals.paragraph}>
        Group votes across all comments, excluding those comments which were moderated out.
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
