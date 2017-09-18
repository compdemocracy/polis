import React from "react";
import Radium from "radium";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";

const Metadata = ({conversation, comments, ptptCount, formatTid, math}) => {

  if (!conversation) {
    return <div>Loading Metadata...</div>
  }

  const _metadataTids = []

  comments.forEach((comment, i) => {
    if (comment.is_meta) { _metadataTids.push(comment.tid) }
  })

  return (
    <div>
      <p style={globals.primaryHeading}> Metadata </p>
      <p style={globals.paragraph}>
        The demographic breakdown of each group, as self reported by agreeing and disagreeing on statements
        marked 'metadata' by moderators.
      </p>
      <div style={{marginTop: 50}}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={_metadataTids.sort((a, b) => a - b) /* es6 ftw */} 
          comments={comments}/>
      </div>
    </div>
  );
};

export default Metadata;
