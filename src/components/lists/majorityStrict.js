import React from "react";
import Radium from "radium";
import _ from "lodash";
import * as globals from "../globals";
import style from "../../util/style";
import CommentList from "./commentList";

const MajorityStrict = ({conversation, comments, ptptCount, consensus, formatTid, math}) => {

  if (!conversation) {
    return <div>Loading Majority (strict)...</div>
  }

  const _comments = _.keyBy(comments, "tid");
  const _consensusTids = [];
  consensus.agree.forEach((c) => {
    _consensusTids.push(c.tid);
  })
  consensus.disagree.forEach((c) => {
    _consensusTids.push(c.tid);
  })

  return (
    <div>
      <p style={globals.primaryHeading}> Majority </p>
      <p style={globals.paragraph}>
        Here's what most people agreed with.
      </p>
      <p style={globals.paragraph}>
        60% or more of all participants voted one way or the other,
        regardless of whether large amounts of certain minority opinion groups voted the other way.
      </p>
      <div style={{marginTop: 50}}>
      <CommentList
        conversation={conversation}
        ptptCount={ptptCount}
        math={math}
        formatTid={formatTid}
        tidsToRender={_consensusTids.sort((a, b) => a - b)}
        comments={comments}/>
      </div>
    </div>
  );
};

export default MajorityStrict;

// These comments were also voted on by greater than [n%] of total voters.
