import React from "react";
import { connect } from "react-redux";
import { populateConversationsStore } from "../actions";
import {Link} from "react-router";
import Radium from "radium";
import _ from "lodash";
import Spinner from "./framework/spinner"

@connect(state => state.conversations)
@Radium
class Conversations extends React.Component {
  componentDidMount() {
    this.props.dispatch(populateConversationsStore())
    // loading true or just do that in constructor
    // check your connectivity and try again
  }
  instantiateConvos() {
    if (!this.props.conversations) { return "No conversations to display" }
    let conversationsMarkup = this.props.conversations.map((conversation, i) => {
      return (
        <div key={i}>
          <p> {conversation.topic} </p>
          <Link to={"/m/"+conversation.conversation_id}>
            {"Admin: " + conversation.conversation_id}
          </Link>
        </div>
      )
    })
    return conversationsMarkup;
  }
  firePopulateInboxAction() {
    this.props.dispatch(populateConversationsStore())
  }
  render() {
    return (
      <div>
        <h1>Conversations</h1>
        <div>
          <div> {this.props.loading ? <Spinner/> : ""} </div>
          <div> {this.instantiateConvos() } </div>
        </div>
      </div>
    );
  }
}

export default Conversations;

// <button onClick={this.firePopulateInboxAction.bind(this)}> Refresh </button>
