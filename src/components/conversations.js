import React from "react";
import { connect } from "react-redux";
import { populateConversationsStore } from "../actions";
import {Link} from "react-router";
import Radium from "radium";
import _ from "lodash";
import Spinner from "./framework/spinner";
import Flex from "./framework/flex";
import Awesome from "react-fontawesome";

const cardHeight = 50;
const cardPadding = "10px 10px 10px 10px";
const cardBorderRadius = 3;

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    padding: "10px 0px 0px 0px",
    minHeight: "100vh"
  },
  conversationCard: {
    height: cardHeight,
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: cardBorderRadius,
    padding: cardPadding,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  toAdminLink: {
    height: cardHeight + (2*cardPadding),
    // backgroundColor: "rgba(200,200,200,1)",
    // marginRight: -cardPadding,
    width: "15%",
    borderTopRightRadius: cardBorderRadius,
    borderBottomRightRadius: cardBorderRadius,
    color: "darkgrey",
    fontWeight: 700,
    fontSize: 24,
    textDecoration: "none",
    display: "flex",
    flexWrap: "wrap",
    listStyle: "none",
    alignItems: "center",
    justifyContent: "center"
  },
  go: {
    marginRight: 10
  }
}

@connect(state => state.conversations)
@Radium
class Conversations extends React.Component {
  componentDidMount() {
    this.props.dispatch(populateConversationsStore())
    // loading true or just do that in constructor
    // check your connectivity and try again
  }
  instantiateConvos() {
    const conversationsMarkup = this.props.conversations.map((conversation, i) => {
      return (
        <Flex
          justifyContent={"space-between"}
          styleOverrides={styles.conversationCard}
          key={i}>
          {/* TODO FLEX */}
          <Flex
            small={2}>
            <span>{conversation.topic}</span>
          {/* <span>{conversation.description}</span> */}
          </Flex>
          <Link
            style={styles.toAdminLink}
            to={"/m/"+conversation.conversation_id}>
              <Awesome name="chevron-right"/>
          </Link>
        </Flex>
      )
    })
    return conversationsMarkup;
  }
  firePopulateInboxAction() {
    this.props.dispatch(populateConversationsStore())
  }
  render() {
    const err = this.props.error;
    return (
      <div styleOverrides={styles.container}>
        {this.props.loading ? <Spinner/> : ""}
        {
          err ?
          "Error loading conversations: " + err.status + " " + err.statusText :
          ""
        }
        {
          !this.props.loading && !this.props.conversations && !err ?
            "No conversations to display" :
            ""
        }
        {this.props.conversations ? this.instantiateConvos() : ""}
      </div>
    );
  }
}

export default Conversations;

/*
  todo
    sorts and filters - by #'s of ptpt etc
*/

            // <span>
            //   {"Admin: " + conversation.conversation_id}
            // </span>
// <button onClick={this.firePopulateInboxAction.bind(this)}> Refresh </button>
