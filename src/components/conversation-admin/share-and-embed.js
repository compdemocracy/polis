import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class ShareAndEmbed extends React.Component {
  render() {
    return (
      <div>
        <h1>ShareAndEmbed</h1>
        <div>
          "ShareAndEmbed"
        </div>
      </div>
    );
  }
}

export default ShareAndEmbed;