// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
import ConversationsTutorialCard from "./conversations-tutorial-card";
import {handleCreateConversationSubmit} from "../actions";
import Url from "../util/url";

@connect((state) => state.conversations)
@Radium
class Conversations extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      filterMinParticipantCount: 0,
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
  goTo(r) {
    return () => {
      browserHistory.push(r);
    };
  }
  goToConversation(conversation_id) {
    return () => {
      if (this.props.route.path === "other-conversations") {
        window.open(`${Url.urlPrefix}${conversation_id}`, "_blank");
        return;
      }
      browserHistory.push(`/m/${conversation_id}`);
    };
  }

  goToDocs() {
    window.location = "http://docs.pol.is"
  }
  onNewClicked() {
    this.props.dispatch(handleCreateConversationSubmit());
  }
  filterCheck(c) {
    // console.log('filtering', c, this.state.filterMinParticipantCount)
    let include = true;

    if (c.participant_count < this.state.filterMinParticipantCount) {
      include = false;
    }

    if (this.props.route.path === "other-conversations") {
      // filter out conversations i do own
      include = c.is_owner ? false : true;
    }

    if (this.props.route.path !== "other-conversations" && !c.is_owner) {
      // if it's not other convos and i'm not the owner, don't show it
      // filter out convos i don't own
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
            clickHandler={this.goToConversation(c.conversation_id)}
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
  renderTutorialCards() {
    return (
      <Flex
        direction="row"
        alignItems="baseline"
        wrap="wrap">
        <ConversationsTutorialCard
          awesome="plus"
          clickHandler={this.onNewClicked.bind(this)}
          body={`
            Single conversations are quick and flexible. You're in control. Drop in a title and
            description, choose moderation settings and send a link to participants.
            Great for playing around with pol.is or embedding pol.is as a feature
            on a single page.
          `}
          title="Start a single conversation"/>
        <ConversationsTutorialCard
          awesome="code"
          clickHandler={this.goTo(`/integrate`)}
          body={`
            Embed pol.is as a comment system across your entire site. Great if you
            have a wordpress blog or other hosting platform that uses templates. Simply
            a script tag into your template. We'll keep track of which conversations
            belong on which pages, and create new ones automatically when needed.
          `}
          title="Integrate polis into your site"/>
        <ConversationsTutorialCard
          awesome="align-left"
          clickHandler={this.goToDocs}
          body={`
            Get oriented! Get the big picture of what pol.is can do and what the default
            settings are. Check out the data pol.is produces and what you can do with it.
            Go deep on user authorization and anonymity strategies.
          `}
          title={"Read the overview & documentation"}/>
      </Flex>
    )
  }
  render() {
    const err = this.props.error;
    const noMoreTutorialsAfterThisNumber = 5;
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
          !this.props.loading && this.props.conversations && this.props.conversations.length < noMoreTutorialsAfterThisNumber && !err ?
            this.renderTutorialCards() :
            ""
        }
        {this.props.conversations ? this.renderFilteredConversations() : ""}
      </Flex>
    );
  }
}

export default Conversations;


/*
    for later when we're showing convos you ptpt i
        <Flex
          wrap="wrap"
          justifyContent="flex-start"
          styleOverrides={styles.navContainer}>
          <NavTab
            active={this.props.routes[3].path ? false : true}
            url={`/m/${this.props.params.conversation_id}/participants/`}
            text="Conversations I Started"
            number={300}/>
          <NavTab
            active={this.props.routes[3].path === "featured"}
            url={`/m/${this.props.params.conversation_id}/participants/featured`}
            text="Conversations I'm In"
            number={10}/>
        </Flex> */

/*
  todo
    sorts and filters - by #'s of ptpt etc
*/

            // <span>
            //   {"Admin: " + conversation.conversation_id}
            // </span>
// <button onClick={this.firePopulateInboxAction.bind(this)}> Refresh </button>
