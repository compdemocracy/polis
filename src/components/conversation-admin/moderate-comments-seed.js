import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.data)
@Radium
class ModerateCommentsSeed extends React.Component {
  render() {
    return (
      <div>
        <h1>ModerateCommentsSeed</h1>
        <div>
          "ModerateCommentsSeed"
        </div>
      </div>
    );
  }
}

export default ModerateCommentsSeed;