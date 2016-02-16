import React from "react";
import { connect } from "react-redux";
import { populateZidMetadataStore, resetMetadataStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";
import Markdown from "react-markdown";
import Spinner from "../framework/spinner";
import StarsSpinner from "../framework/stars-spinner";

const cardHeight = 50;
const cardPadding = 10;
const cardBorderRadius = 3;

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    paddingTop: 10,
    minHeight: "100vh"
  }
}

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

  componentDidUpdate () {
    this.loadZidMetadata();
  }
  renderSpinner() {
    return (
      <StarsSpinner
        text={"Loading conversation..."}
        nodeColor={ "rgb(150,150,150)" }
        count={ Math.floor(window.innerWidth / 10) }
        width={ window.innerWidth }
        height={ window.innerHeight }
        radius={ 1.5 }
        lineWidth={ 1 }/>
    )
  }
  render() {
    return (
      <div style={styles.container}>
        {
          this.props.zid_metadata.conversation_id ?
            this.props.children :
            this.renderSpinner()
        }
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
