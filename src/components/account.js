import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Spinner from "./framework/spinner";

@connect(state => state.user)
@Radium
class Account extends React.Component {
  buildAccountMarkup() {
    // probably a component / series of them
    return (
      <div>
        <p>{this.props.user.hname}</p>
        <p>{this.props.user.email}</p>
        <p>{this.props.user.hasTwitter ? this.props.user.twitter.location : "Location Unknown"}</p>
        <p>{this.props.user.hasFacebook ? "Facebook is connected. Disconnect." : "Connect Facebook"} </p>
        <p>{this.props.user.hasTwitter ? "Twitter is connected Disconnect" : "Connect Twitter"}</p>
        <p>{"Your plan is: " + this.props.user.plan} <button> Upgrade </button></p>
        <button> {"Generate api token for scripting starting convos"} </button>
      </div>
    )
  }
  render() {
    console.log(this.props.user)
    return (
      <div>
        <h1>Account</h1>
        <div>
          {
            this.props.loading === true ? <Spinner/> :
            this.buildAccountMarkup()
          }
        </div>
      </div>
    );
  }
}

export default Account;