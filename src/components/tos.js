import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { doSignout } from "../actions";

@connect(state => state.signout)
@Radium
class TOS extends React.Component {

  render() {
    return (
      <div>
        <h1>Signing Out</h1>
      </div>
    );
  }
}

export default TOS;
