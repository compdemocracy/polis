import React from "react";
// import { connect } from "react-redux";
import probabilities from "../sampleData/probabilities";

import Radium from "radium";
import _ from "lodash";

import Report from "./report";

import net from "../util/net"

import $ from 'jquery';

var conversation_id = "2ez5beswtc";

@Radium
class App extends React.Component {


  getMath() {
    return net.polisGet("/api/v3/math/pca2", {
      lastVoteTimestamp: 0,
      conversation_id: conversation_id,
    });
  }

  getAgreeMatrix() {
    return net.polisGet("/api/v3/voteProbabilityMatrixAgree", {
      conversation_id: conversation_id,
    });
  }
  getComments() {
    return net.polisGet("/api/v3/comments", {
      conversation_id: conversation_id,
      moderation: true,
      include_social: true,
    });
  }

  getParticipantsOfInterest() {
    return net.polisGet("/api/v3/ptptois", {
      conversation_id: conversation_id,
    });
  }

  getData() {
    Promise.all([
      this.getMath(),
      this.getAgreeMatrix(),
      this.getComments(),
      this.getParticipantsOfInterest(),
    ]).then((a) => {
      var mathResult = a[0];
      var coOccurrenceAgreeResult = a[1];

      this.setState({
        probabilitiesAgree: coOccurrenceAgreeResult.matrix,
        probabilitiesAgreeTids: coOccurrenceAgreeResult.rowToTid,

      });
    }, (err) => {
      this.setState({
        probabilitiesAgreeError: (err || true),
      });
    });
  }

  componentWillMount() {
    this.getData();
  }

  render() {
    return <Report probabilities={this.state.probabilitiesAgree} tids={this.state.probabilitiesAgreeTids} error={this.state.probabilitiesAgreeError}/>;
  }
}

export default App;

window.$ = $;
