import React from "react";
import Radium from "radium";
import _ from "lodash";
import * as globals from "./globals";

const computeVoteTotal = (users) => {
  let voteTotal = 0;

  _.each(users, (count) => {
    voteTotal += count
  });

  return voteTotal;
}

const computeUniqueCommenters = (comments) => {

}

const Number = ({number, label}) => (
  <div>
    <p style={globals.overviewNumber}>
      {number}
    </p>
    <p style={globals.overviewLabel}>
      {label}
    </p>
  </div>
)

const Overview = ({
  conversation,
  demographics,
  ptptCount,
  math,
  comments,
  stats,
}) => {
  return (
    <div >
      <p style={globals.primaryHeading}>Overview</p>

      <p style={globals.paragraph}>
        {conversation && conversation.ownername ? "This pol.is conversation was run by "+conversation.ownername+". " : null}
        {conversation && conversation.topic ? "The topic was '"+conversation.topic+"'. " : null}
      </p>
      <div style={{maxWidth: 800, display: "flex", justifyContent: "space-between"}}>
        <Number number={ptptCount} label={"people voted"} />
        <Number
          number={ computeVoteTotal(math["user-vote-counts"]) }
          label={"votes were cast"} />
        <Number number={stats.firstCommentTimes.length} label={"people submitted comments"} />
        <Number number={math["n-cmts"]} label={"comments were submitted"} />
      </div>

    </div>
  );
};

export default Overview;

// <p style={globals.paragraph}> {conversation && conversation.participant_count ? "A total of "+ptptCount+" people participated. " : null} </p>


// It was presented {conversation ? conversation.medium : "loading"} to an audience of {conversation ? conversation.audiences : "loading"}.
// The conversation was run for {conversation ? conversation.duration : "loading"}.
 // {demographics ? demographics.foo : "loading"} were women

 // {conversation && conversation.description ? "The specific question was '"+conversation.description+"'. ": null}
