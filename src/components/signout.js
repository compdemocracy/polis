import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import { doSignout } from "../actions";

@connect(state => state.signout)
@Radium
class SignOut extends React.Component {

  componentWillMount () {
    var dest = this.props.location.pathname.slice("/signout".length);
    this.props.dispatch(doSignout(dest))
  }

  render() {
    return (
      <div>
        <h1>Signing Out</h1>
      </div>
    );
  }
}

export default SignOut;
