import React from "react";
// import { connect } from "react-redux";
import probabilities from "../sampleData/probabilities";
import covariance from "../sampleData/covariance";
import correlation from "../sampleData/correlation";
import correlationHClust from "../sampleData/correlationHClust"
import * as globals from "./globals";

import Radium from "radium";
import _ from "lodash";

import Matrix from "./Matrix";
import Heading from "./Heading";
import Overview from "./Overview";
import Consensus from "./Consensus";
import Contested from "./Contested";
import AllComments from "./AllComments";
import ParticipantGroups from "./ParticipantGroups";
import Graph from "./Graph";

import net from "../util/net"

import $ from 'jquery';

var pathname = window.location.pathname; // "/report/2arcefpshi"
var conversation_id = pathname.split("/")[2];


class App extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      consensus: null,
      comments: null,
      participants: null,
      conversation: null,
      groupDemographics: null,
      dimensions: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    };
  }

  getMath() {
    return net.polisGet("/api/v3/math/pca2", {
      lastVoteTimestamp: 0,
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
      this.getComments(),
      this.getParticipantsOfInterest(),
      this.getConversation(),
      this.getGroupDemographics()
    ]).then((a) => {
      const mathResult = a[0];
      const comments = a[1];
      const participants = a[2];
      const conversation = a[3];
      const groupDemographics = a[4];

      var ptptCount = 0;
      _.each(mathResult["group-votes"], (val, key) => {
        ptptCount += val["n-members"];
      });

      // prep Correlation matrix.
      var probabilities = correlationHClust.matrix;
      var tids =  correlationHClust.comments;
      var badTids = {};
      for (let row = 0; row < probabilities.length; row++) {
        if (probabilities[row][0] === "NaN") {
          let tid = correlationHClust.comments[row];
          badTids[tid] = true;
          console.log("bad", tid);
        }
      }
      var filteredProbabilities = probabilities.map((row) => {
        return row.filter((cell, colNum) => {
          let colTid = correlationHClust.comments[colNum];
          return badTids[colTid] !== true;
        });
      }).filter((row, rowNum) => {
          let rowTid = correlationHClust.comments[rowNum];
          return badTids[rowTid] !== true;
      });
      var filteredTids =tids.filter((tid, index) => {
        return badTids[tid] !== true;
      });

      var maxTid = -1;
      for (let i = 0; i < comments.length; i++) {
        if (comments[i].tid > maxTid) {
          maxTid = comments[i].tid;
        }
      }
      var tidWidth = ("" + maxTid).length

      function pad(n, width, z) {
        z = z || '0';
        n = n + '';
        return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
      }
      function formatTid(tid) {
        let padded = "" + tid;
        return '#' + pad(""+tid, tidWidth);
      }


      this.setState({
        math: mathResult,
        consensus: mathResult.consensus,
        comments: comments,
        demographics: groupDemographics,
        participants: participants,
        conversation: conversation,
        ptptCount: ptptCount,
        filteredCorrelationMatrix: filteredProbabilities,
        filterecCorrelationTids: filteredTids,
        badTids: badTids,
        groupNames: globals.groupNames,
        formatTid: formatTid,
      });
    }, (err) => {
      this.setState({
        error: true,
        errorText: err,
      });
    });
  }

  componentWillMount() {
    this.getData();
    window.addEventListener("resize", _.throttle(() => {
      this.setState({
        dimensions: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      })
    }, 500));
  }

  render() {
    if (this.state.error) {
      return (<div>
        <div> Error Loading </div>
        <div> {this.state.errorText} </div>
      </div>);
    }
    return (
      <div style={{margin: 20}}>
        <Heading conversation={this.state.conversation}/>
        <Overview
          ptptCount={this.state.ptptCount}
          demographics={this.state.demographics}
          conversation={this.state.conversation}/>
        <Consensus
          conversation={this.state.conversation}
          ptptCount={this.state.ptptCount}
          comments={this.state.comments}
          formatTid={this.state.formatTid}
          consensus={this.state.consensus}/>

        <ParticipantGroups
          comments={this.state.comments}
          conversation={this.state.conversation}
          demographics={this.state.demographics}
          comments={this.state.comments}
          ptptCount={this.state.ptptCount}
          groupNames={this.state.groupNames}
          formatTid={this.state.formatTid}
          math={this.state.math}/>
        <Graph
          comments={this.state.comments}
          groupNames={this.state.groupNames}
          badTids={this.state.badTids}
          formatTid={this.state.formatTid}
          math={this.state.math}/>
        <AllComments
          conversation={this.state.conversation}
          ptptCount={this.state.ptptCount}
          formatTid={this.state.formatTid}
          comments={this.state.comments}/>
      </div>
    );
  }
}

export default App;

window.$ = $;
