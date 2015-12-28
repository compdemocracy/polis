import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Spinner from "./framework/spinner";

const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}

@connect(state => state.user)
@Radium
class Account extends React.Component {
  buildAccountMarkup() {
    // probably a component / series of them
    return (
      <div style={styles.card}>
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
        {
          this.props.loading === true ? <Spinner/> :
          this.buildAccountMarkup()
        }
      </div>
    );
  }
}

export default Account;