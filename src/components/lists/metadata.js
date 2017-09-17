import React from "react";
import Radium from "radium";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";

const Uncertainty = ({conversation, comments, ptptCount, meta, formatTid, math}) => {

  if (!conversation) {
    return <div>Loading Uncertainty...</div>
  }

  const _comments = _.keyBy(comments, "tid");

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
          tidsToRender={meta /* uncertainTids would be funnier */}
          comments={comments}/>
      </div>
    </div>
  );
};

export default Uncertainty;
