import React from "react";
import { connect } from "react-redux";
import { populateZidMetadataStore, resetMetadataStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";
import Markdown from "react-markdown";
import Spinner from "../framework/spinner";

@connect(state => state.zid_metadata)
@Radium
class ConversationAdminContainer extends React.Component {

  loadZidMetadata() {
    this.props.dispatch(
      populateZidMetadataStore(this.props.params.conversation_id)
    )
  }

  resetMetadata() {
    this.props.dispatch(
      resetMetadataStore()
    )
  }

  componentWillMount () {
    this.loadZidMetadata();
  }

  componentWillUnmount () {
    this.resetMetadata();
  }

  componentWillUpdate () {
    this.loadZidMetadata();
  }


  render() {
    return (
      <div>
        {this.props.zid_metadata.conversation_id ? this.props.children : <Spinner/>}
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