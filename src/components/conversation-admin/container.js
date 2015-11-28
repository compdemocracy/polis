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

  render() {
    console.log("container props", this.props)
    return (
      <div>
        <h3> {this.props.zid_metadata.topic} </h3>
        <Markdown source={this.props.zid_metadata.description} />
        <p> {this.props.zid_metadata.} </p>
        {this.props.children}
      </div>
    );
  }
}

export default ConversationAdminContainer;
