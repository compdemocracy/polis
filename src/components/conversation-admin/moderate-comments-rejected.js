import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class ModerateCommentsRejected extends React.Component {
  render() {
    return (
      <div>
        <h1>ModerateCommentsRejected</h1>
        <div>
          "ModerateCommentsRejected"
        </div>
      </div>
    );
  }
}

export default ModerateCommentsRejected;