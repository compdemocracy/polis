import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class SignIn extends React.Component {
  render() {
    return (
      <div>
        <h1>SignIn</h1>
        <div>
          "SignIn"
        </div>
      </div>
    );
  }
}

export default SignIn;