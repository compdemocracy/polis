import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.data)
@Radium
class ParticipantModerationHidden extends React.Component {
  render() {
    return (
      <div>
        <h1>ParticipantModerationHidden</h1>
        <div>
          "ParticipantModerationHidden"
        </div>
      </div>
    );
  }
}

export default ParticipantModerationHidden;