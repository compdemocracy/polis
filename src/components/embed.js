import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.data)
@Radium
class Embed extends React.Component {
  render() {
    return (
      <div>
        <h1>Embed</h1>
        <div>
          "Embed"
        </div>
      </div>
    );
  }
}

export default Embed;