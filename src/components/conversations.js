import React from "react";
import { connect } from "react-redux";
import { populateConversationsStore } from "../actions";
import { browserHistory } from "react-router";
import Radium from "radium";
// import _ from "lodash";
import Spinner from "./framework/spinner";
import Flex from "./framework/flex";
// import Awesome from "react-fontawesome";

const styles = {

  conversationCard: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  }
};

@connect((state) => state.conversations)
@Radium
class Conversations extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    conversations: React.PropTypes.object,
    error: React.PropTypes.object,
    loading: React.PropTypes.bool
    /* component api */
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  componentDidMount() {
    this.props.dispatch(populateConversationsStore());
    // loading true or just do that in constructor
    // check your connectivity and try again
  }
  goToConversation(r) {
    return () => {
      browserHistory.push(r);
    }
  }
  instantiateConvos() {
    const conversationsMarkup = this.props.conversations.map((conversation, i) => {
      return (
        <Flex
          justifyContent={"space-between"}
          styleOverrides={styles.conversationCard}
          key={i}>
          <div
            style={{width: "100%", height: "100%", padding: 20, cursor: 'pointer'}}
            onClick={this.goToConversation("/m/"+conversation.conversation_id)}>
            <span>{conversation.topic}</span>
          {/* <span>{conversation.description}</span> */}
          </div>
        </Flex>
      );
    });
    return conversationsMarkup;
  }
  firePopulateInboxAction() {
    this.props.dispatch(populateConversationsStore());
  }
  render() {
    const err = this.props.error;
    return (
      <div>
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
