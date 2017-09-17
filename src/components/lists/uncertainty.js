import React from "react";
import Radium from "radium";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";

const Uncertainty = ({conversation, comments, ptptCount, uncertainty, formatTid, math}) => {

  if (!conversation) {
    return <div>Loading Uncertainty...</div>
  }

  const _comments = _.keyBy(comments, "tid");

  return (
    <div>
      <p style={globals.primaryHeading}> Areas of uncertainty </p>
      <p style={globals.paragraph}>
        Across all {ptptCount} participants, there was uncertainty about the following comments.
        Greater than 30% of participants who saw these comments 'passed'.
      </p>
      <p style={globals.paragraph}>
        Areas of uncertainty can provide avenues to educate and open dialogue with your community.
      </p>
      <div style={{marginTop: 50}}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={uncertainty /* uncertainTids would be funnier */}
          comments={comments}/>
      </div>
    </div>
  );
};

export default Uncertainty;
