import React from "react";
// import { connect } from "react-redux";
import probabilities from "../sampleData/probabilities";

import Radium from "radium";
import _ from "lodash";

import Matrix from "./Matrix";
import Heading from "./Heading";
import Overview from "./Overview";
import Consensus from "./Consensus";
import Contested from "./Contested";
import AllComments from "./AllComments";
import ParticipantGroups from "./ParticipantGroups";

import net from "../util/net"

import $ from 'jquery';

var conversation_id = "2ez5beswtc";

class App extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      consensus: null,
      comments: null,
      participants: null,
      probabilitiesAgree: null,
      probabilitiesAgreeTids: null,
      conversation: null,
      groupDemographics: null
    };
  }

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
      mod_gt: -1,
      include_social: true,
      include_demographics: true
    });
  }

  getParticipantsOfInterest() {
    return net.polisGet("/api/v3/ptptois", {
      conversation_id: conversation_id,
    });
  }
  getConversation() {
    return net.polisGet("/api/v3/conversations", {
      conversation_id: conversation_id,
    });
  }
  getGroupDemographics() {
    return net.polisGet("/api/v3/group_demographics", {
      conversation_id: conversation_id,
    });

  }
  getData() {
    Promise.all([
      this.getMath(),
      this.getAgreeMatrix(),
      this.getComments(),
      this.getParticipantsOfInterest(),
      this.getConversation(),
      this.getGroupDemographics()
    ]).then((a) => {
      const mathResult = a[0];
      const coOccurrenceAgreeResult = a[1];
      const comments = a[2];
      const participants = a[3];
      const conversation = a[4];
      const groupDemographics = a[5];

      console.log(a)

      this.setState({
        math: mathResult,
        consensus: mathResult.consensus,
        comments: comments,
        participants: participants,
        probabilitiesAgree: coOccurrenceAgreeResult.matrix,
        probabilitiesAgreeTids: coOccurrenceAgreeResult.rowToTid,
        conversation: conversation
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
    return (
      <div style={{margin: 20}}>
        <Heading/>
        <Overview/>
        <Consensus
          conversation={this.state.conversation}
          comments={this.state.comments}
          consensus={this.state.consensus}/>
        <Matrix
          probabilities={this.state.probabilitiesAgree}
          tids={this.state.probabilitiesAgreeTids}
          error={this.state.probabilitiesAgreeError}/>
        <ParticipantGroups
          comments={this.state.comments}
          conversation={this.state.conversation}
          demographics={this.state.demographics}
          comments={this.state.comments}
          math={this.state.math}/>
        <p> ==================================== End Analysis ==================================== </p>
        <AllComments
          conversation={this.state.conversation}
          comments={this.state.comments}/>
      </div>
    );
  }
}

export default App;

window.$ = $;
