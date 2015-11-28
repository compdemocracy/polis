import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class ParticipantModerationDefault extends React.Component {
  render() {
    return (
      <div>
        <h1>ParticipantModerationDefault</h1>
        <div>
          "ParticipantModerationDefault"
        </div>
      </div>
    );
  }
}

export default ParticipantModerationDefault;