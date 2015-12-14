import React from "react";
import { connect } from "react-redux";
import { populateZidMetadataStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";
import Markdown from "react-markdown";

@connect(state => state.zid_metadata)
@Radium
class ConversationAdminContainer extends React.Component {

  loadZidMetadata() {
    this.props.dispatch(
      populateZidMetadataStore(this.props.params.conversation)
    )
  }

  componentWillMount () {
    this.loadZidMetadata()
  }

  componentWillUnmount () {
    // nukeZidMetadataStore
  }

  render() {
    return (
      <div>
        {this.props.children}
      </div>
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