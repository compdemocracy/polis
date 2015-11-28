import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class OverallStats extends React.Component {
  render() {
    return (
      <div>
        <h1>OverallStats</h1>
        <div>
          "OverallStats"
        </div>
      </div>
    );
  }
}

export default OverallStats;