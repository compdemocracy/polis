import React from "react";
import Radium from "radium";
// import _ from "lodash";
import * as globals from "./globals";

const Overview = ({conversation, demographics}) => {
  console.log(conversation, demographics)
  return (
    <div>
      <p style={{fontSize: globals.primaryHeading}}>Overview</p>

      <p style={globals.paragraph}>
        {conversation && conversation.ownername ? "This conversation was run by "+conversation.ownername+". " : null}
        {conversation && conversation.topic ? "The topic was set as '"+conversation.topic+"'. " : null}
        {conversation && conversation.description ? "The specific question was '"+conversation.description+"'. ": null}
        {conversation && conversation.participant_count ? "A total of "+conversation.participant_count+" people participated. " : null}
      </p>
    </div>
  );
};

export default Overview;

// It was presented {conversation ? conversation.medium : "loading"} to an audience of {conversation ? conversation.audiences : "loading"}.
// The conversation was run for {conversation ? conversation.duration : "loading"}.
 // {demographics ? demographics.foo : "loading"} were women
