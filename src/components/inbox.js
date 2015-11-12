import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

@connect(state => state.conversations)
@Radium
class Inbox extends React.Component {
  componentDidMount() {
    // fire get all conversations
    // loading true or just do that in constructor
    // check your connectivity and try again
  }
  fetchConversations() {
    this.props.dispatch()
  }
  render() {
    return (
      <div>
        <h1>Inbox</h1>
        <div>
          "Inbox"
          <p> {this.props.message} </p>
          <button onClick={this.fetchConversations()}> Refresh </button>
        </div>
      </div>
    );
  }
}

export default Inbox;
