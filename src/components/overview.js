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
      {number.toLocaleString()}
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
  ptptCountTotal,
  math,
  comments,
  stats,
  computedStats,
}) => {
  return (
    <div >
      <p style={globals.primaryHeading}>Overview</p>
      <p style={globals.paragraph}>
        Pol.is is a real-time survey system that helps identify the different ways a large group of people think about a divisive or complicated topic. Here’s a basic breakdown of some terms you’ll need to know in order to understand this report.
      </p>
      <p style={globals.paragraph}>
        <strong>Participants:</strong> These are the people who participated in the conversation by voting and writing statements. Based on how they voted, each participant is sorted into an opinion group.
      </p>
      <p style={globals.paragraph}>
        <strong>Statements:</strong> Participants may submit statements for other participants to vote on. Statements are assigned a number in the order they’re submitted.
      </p>
      <p style={globals.paragraph}>
        <strong>Opinion groups:</strong> Groups are made of participants who voted similarly to each other, and differently from the other groups.
      </p>

      <p style={globals.paragraph}>
        {conversation && conversation.ownername ? "This pol.is conversation was run by "+conversation.ownername+". " : null}
        {conversation && conversation.topic ? "The topic was '"+conversation.topic+"'. " : null}
      </p>
      <div style={{maxWidth: 1200, display: "flex", justifyContent: "space-between"}}>
        <Number number={ptptCountTotal} label={"people voted"} />
        <Number number={ptptCount} label={"people grouped"} />

        <Number
          number={ computeVoteTotal(math["user-vote-counts"]) }
          label={"votes were cast"} />
        <Number number={stats.firstCommentTimes.length} label={"people submitted statements"} />
        <Number number={math["n-cmts"]} label={"statements were submitted"} />
        <Number number={computedStats.votesPerVoterAvg.toFixed(2)} label={"votes per voter on average"} />
        <Number number={computedStats.commentsPerCommenterAvg.toFixed(2)} label={"statements per author on average"} />

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
