import React from "react";
import { connect } from "react-redux";
import { populateConversationsStore } from "../actions";
import { browserHistory } from "react-router";
import Radium from "radium";
// import _ from "lodash";
import Spinner from "./framework/spinner";
import Flex from "./framework/flex";
import * as globals from "./framework/global-styles";
import Awesome from "react-fontawesome";
import ConversationFilters from "./conversation-filters";

@connect((state) => state.conversations)
@Radium
class Conversations extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      filterMinParticipantCount: 10,
      sort: "participant_count"
    };
  }
  static propTypes = {
    /* react */
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    conversations: React.PropTypes.array,
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
  getStyles() {
    return {
      container: {
        backgroundColor: "rgb(240,240,247)",
        // paddingTop: globals.headerHeight,
        minHeight: "100%"
      },
      conversationCard: {
        width: "90%",
        padding: 20,
        cursor: "pointer",
        margin: "10px 0px",
        color: "rgb(100,100,100)",
        backgroundColor: "rgb(253,253,253)",
        borderRadius: 3,
        WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
        BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
      },
      awesome: {
        fontSize: 16,
        marginRight: 6,
        position: "relative",
        top: -2
      },
      statNumber: {
        fontSize: 18,
        marginBottom: 20
      },
      parentUrl: {
        fontSize: 12,
        marginTop: 10
      },
      topic: {
        marginBottom: 10
        // ":hover": {
        //   color: 'red'
        // }
      },
      description: {
        fontSize: 14,
        fontWeight: 300,
      }
    };
  }
  goToConversation(r) {
    return () => {
      browserHistory.push(r);
    };
  }
  filterCheck(c) {
    // console.log('filtering', c, this.state.filterMinParticipantCount)
    let include = true;
    if (c.participant_count < this.state.filterMinParticipantCount) {
      include = false;
    }
    return include;
  }
  renderFilteredConversations() {
    const conversationsMarkup = this.props.conversations.map((c, i) => {
      let markup = "";
      if (this.filterCheck(c)) {
        markup = (
          <Flex
            justifyContent="flex-start"
            direction="column"
            alignItems="flex-start"
            styleOverrides={this.getStyles().conversationCard}
            clickHandler={this.goToConversation(`/m/${c.conversation_id}`)}
            key={i}>
              <span ref={`statNumber${i}`} style={this.getStyles().statNumber}>
                <Awesome name="users" style={this.getStyles().awesome}/>
                {c.participant_count}
              </span>
              <span ref={`topic${i}`} style={this.getStyles().topic}>
                {c.topic}
              </span>
              <span ref={`description${i}`} style={this.getStyles().description}>
                {c.description}
              </span>
              <span ref={`parentUrl${i}`} style={this.getStyles().parentUrl}>
                {c.parent_url ? `Embedded on ${c.parent_url}` : ""}
              </span>
          </Flex>
        );
      }
      return markup;
    });
    return conversationsMarkup;
  }
  firePopulateInboxAction() {
    this.props.dispatch(populateConversationsStore());
  }
  onFilterChange() {
    this.setState()
  }
  render() {
    const err = this.props.error;
    return (
      <Flex
        direction="column"
        justifyContent="flex-start"
        styleOverrides={this.getStyles().container}>
        <p style={{paddingLeft: 20, textAlign: "center"}}>
          {this.props.loading ? "Loading conversations..." : ""}
        </p>
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
        {this.props.conversations ? this.renderFilteredConversations() : ""}
      </Flex>
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
