import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.data)
@Radium
class Account extends React.Component {
  render() {
    return (
      <div>
        <h1>Account</h1>
        <div>
          "Account"
        </div>
      </div>
    );
  }
}

export default Account;