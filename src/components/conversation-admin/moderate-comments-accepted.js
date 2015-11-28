import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class ModerateCommentsAccepted extends React.Component {
  render() {
    return (
      <div>
        <h1>ModerateCommentsAccepted</h1>
        <div>
          "ModerateCommentsAccepted"
        </div>
      </div>
    );
  }
}

export default ModerateCommentsAccepted;