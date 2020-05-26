// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { populateConversationsStore } from "../actions";
import { handleCreateConversationSubmit } from "../actions";
import Url from "../util/url";
import Explainer from "./explainer";

@connect((state) => state.conversations)
class Conversations extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      filterMinParticipantCount: 0,
      sort: "participant_count",
    };
  }

  componentDidMount() {
    this.props.dispatch(populateConversationsStore());
    // loading true or just do that in constructor
    // check your connectivity and try again
  }

  goTo(r) {
    return () => {
      this.props.history.push(r);
    };
  }
  goToConversation(conversation_id) {
    return () => {
      if (this.props.history.pathname === "other-conversations") {
        window.open(`${Url.urlPrefix}${conversation_id}`, "_blank");
        return;
      }
      this.props.history.push(`/m/${conversation_id}`);
    };
  }

  goToDocs() {
    window.location = "http://docs.pol.is";
  }
  onNewClicked() {
    this.props.dispatch(handleCreateConversationSubmit());
  }
  filterCheck(c) {
    let include = true;

    if (c.participant_count < this.state.filterMinParticipantCount) {
      include = false;
    }

    if (this.props.history.pathname === "other-conversations") {
      // filter out conversations i do own
      include = c.is_owner ? false : true;
    }

    if (this.props.history.pathname !== "other-conversations" && !c.is_owner) {
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
          <div onClick={this.goToConversation(c.conversation_id)} key={i}>
            <p ref={`statNumber${i}`}>{c.participant_count} participants</p>
            <p ref={`topic${i}`}>{c.topic}</p>
            <p ref={`description${i}`}>{c.description}</p>
            <p ref={`parentUrl${i}`}>{c.parent_url ? `Embedded on ${c.parent_url}` : ""}</p>
          </div>
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
    this.setState();
  }

  render() {
    const err = this.props.error;
    return (
      <div>
        <p>{this.props.loading ? "Loading conversations..." : ""}</p>
        {err ? "Error loading conversations: " + err.status + " " + err.statusText : ""}
        {this.props.conversations ? this.renderFilteredConversations() : ""}
        <div>
          <Explainer />
        </div>
      </div>
    );
  }
}

export default Conversations;
