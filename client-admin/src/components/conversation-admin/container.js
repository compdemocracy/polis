// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { populateZidMetadataStore, resetMetadataStore } from "../../actions";
import _ from "lodash";

@connect((state) => state.zid_metadata)
class ConversationAdminContainer extends React.Component {
  loadZidMetadata() {
    this.props.dispatch(populateZidMetadataStore(this.props.params.conversation_id));
  }

  resetMetadata() {
    this.props.dispatch(resetMetadataStore());
  }

  componentWillMount() {
    this.loadZidMetadata();
  }

  componentWillUnmount() {
    this.resetMetadata();
  }

  componentDidUpdate() {
    this.loadZidMetadata();
  }

  render() {
    return (
      <div>{this.props.zid_metadata.conversation_id ? this.props.children : "Loading..."}</div>
    );
  }
}

export default ConversationAdminContainer;

// <h3> {this.props.zid_metadata.topic} </h3>
// <Markdown source={this.props.zid_metadata.description} />

// <p> Embedded on:
//   <a href={this.props.zid_metadata.parent_url}>
//     {this.props.zid_metadata.parent_url ? this.props.zid_metadata.parent_url : "Not embedded"}
//   </a>
// </p>
// <p>{"Participant count: " + this.props.zid_metadata.participant_count}</p>
