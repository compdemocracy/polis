import React from "react";
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";
import * as globals from "./globals";
import style from "../util/style";

const Uncertainty = ({conversation, comments, ptptCount, uncertainty, formatTid}) => {

  const _comments = _.keyBy(comments, "tid");

  if (!conversation) {
    return <div>Loading Uncertainty...</div>
  }

  return (
    <div>
      <p style={{fontSize: globals.primaryHeading}}> Areas of uncertainty </p>
      <p style={globals.paragraph}>
        Across all {ptptCount} participants, there was uncertainty about the following comments. Greater than 30% of participants who saw these comments 'passed'.
      </p>
      <div style={{marginTop: 50}}>
      {
        uncertainty ? uncertainty.map((tid, i) => {
          return <Comment
            conversation={conversation}
            key={i}
            index={i}
            comment={_comments[tid]}
            formatTid={formatTid}
            ptptCount={ptptCount}/>
        })
        : "Loading uncertainty"
      }
      </div>
    </div>
  );
};

export default Uncertainty;
