import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.data)
@Radium
class Inbox extends React.Component {
  render() {
    return (
      <div>
        <h1>Inbox</h1>
        <div>
          "Inbox"
        </div>
      </div>
    );
  }
}

export default Inbox;