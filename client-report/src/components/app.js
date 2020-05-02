// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
// import { connect } from "react-redux";
// import probabilities from "../sampleData/probabilities";
// import covariance from "../sampleData/covariance";
// import correlation from "../sampleData/correlation";
// import correlationHClust from "../sampleData/correlationHClust"
import _ from "lodash";

import * as globals from "./globals";
import DataUtils from "../util/dataUtils";
import Matrix from "./correlationMatrix/matrix";
import Heading from "./framework/heading";
import Footer from "./framework/Footer";
import Overview from "./overview";
import MajorityStrict from "./lists/majorityStrict";
import Uncertainty from "./lists/uncertainty";
import AllCommentsModeratedIn from "./lists/allCommentsModeratedIn"
import ParticipantGroups from "./lists/participantGroups";
import CommentsGraph from "./commentsGraph/commentsGraph";
import ParticipantsGraph from "./participantsGraph/participantsGraph";
import BoxPlot from "./boxPlot/boxPlot";
import Beeswarm from "./beeswarm/beeswarm";
import Controls from "./controls/controls";

import net from "../util/net"

import $ from 'jquery';

var pathname = window.location.pathname; // "/report/2arcefpshi"
var report_id = pathname.split("/")[2];


function assertExists(obj, key) {
  if (typeof obj[key] === "undefined") {
    console.error("assertExists failed. Missing: ", key);
  }
}

class App extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      loading: true,
      consensus: null,
      comments: null,
      participants: null,
      conversation: null,
      groupDemographics: null,
      colorBlindMode: false,
      dimensions: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      shouldPoll: false,
      voteColors: {
        agree: globals.brandColors.agree,
        disagree: globals.brandColors.disagree,
        pass: globals.brandColors.pass,
      },
    };
  }

  getMath(conversation_id) {
    return net.polisGet("/api/v3/math/pca2", {
      lastVoteTimestamp: 0,
      conversation_id: conversation_id,
    }).then((data) => {
      if (!data) {
        return {};
      }
      return data;
    });
  }

  getComments(conversation_id, isStrictMod) {
    return net.polisGet("/api/v3/comments", {
      conversation_id: conversation_id,
      report_id: report_id,
      moderation: true,
      mod_gt: isStrictMod ? 0 : -1,
      //include_social: true,
      //include_demographics: true,
      include_voting_patterns: true,
    });
  }

  getParticipantsOfInterest(conversation_id) {
    return net.polisGet("/api/v3/ptptois", {
      conversation_id: conversation_id,
    });
  }
  getConversation(conversation_id) {
    return net.polisGet("/api/v3/conversations", {
      conversation_id: conversation_id,
    });
  }
  getReport(report_id) {
    return net.polisGet("/api/v3/reports", {
      report_id: report_id,
    }).then((reports) => {
      if (reports.length) {
        return reports[0];
      }
      return null;
    });
  }
  getGroupDemographics(conversation_id) {
    return net.polisGet("/api/v3/group_demographics", {
      conversation_id: conversation_id,
      report_id: report_id,
    });
  }

  getConversationStats(conversation_id) {
    return net.polisGet("/api/v3/conversationStats", {
      conversation_id: conversation_id,
      report_id: report_id,
    });
  }

  getCorrelationMatrix(math_tick) {
    const attemptResponse = net.polisGet("/api/v3/math/correlationMatrix", {
      math_tick: math_tick,
      report_id: report_id,
    });

    return new Promise((resolve, reject) => {
      attemptResponse.then((response) => {
        if (response.status && response.status === "pending") {
          this.corMatRetries = _.isNumber(this.corMatRetries) ? this.corMatRetries + 1 : 1;
          setTimeout(() => {
            this.getCorrelationMatrix(math_tick).then(resolve, reject);
          }, this.corMatRetries < 10 ? 200 : 3000); // try to get a quick response, but don't keep polling at that rate for more than 10 seconds.
        } else if (globals.enableMatrix && response && response.status === "polis_report_needs_comment_selection") {
          this.setState({
            errorLink: "http://localhost:5002/m/36jajfnhhn/reports/r6ehukhk29tcfmuc57vrj/comments",
            errorLinkText: "Select some comments",
          });
          reject("Currently, No comments are selected for display in the matrix.");
        } else {
          resolve(response);
        }
      }, (err) => {
        reject(err);
      });
    });
  }

  getData() {
    const reportPromise = this.getReport(report_id);
    // debug initial report data fetch
    reportPromise.then((report) => console.log("report recieved:", report))
    const mathPromise = reportPromise.then((report) => {
      return this.getMath(report.conversation_id);
    });
    const commentsPromise = reportPromise.then((report) => {
      return conversationPromise.then((conv) => {
        return this.getComments(report.conversation_id, conv.strict_moderation);
      });
    });
    const groupDemographicsPromise = reportPromise.then((report) => {
      return this.getGroupDemographics(report.conversation_id);
    });
    //const conversationStatsPromise = reportPromise.then((report) => {
      //return this.getConversationStats(report.conversation_id)
    //});
    const participantsOfInterestPromise = reportPromise.then((report) => {
      return this.getParticipantsOfInterest(report.conversation_id);
    });
    const matrixPromise = globals.enableMatrix ? mathPromise.then((math) => {
      const math_tick = math.math_tick;
      return this.getCorrelationMatrix(math_tick);
    }) : Promise.resolve();
    const conversationPromise = reportPromise.then((report) => {
      return this.getConversation(report.conversation_id);
    });

    Promise.all([
      reportPromise,
      mathPromise,
      commentsPromise,
      groupDemographicsPromise,
      participantsOfInterestPromise,
      matrixPromise,
      conversationPromise,
      //conversationStatsPromise,
    ]).then((a) => {
      let [
        report,
        mathResult,
        comments,
        groupDemographics,
        participants,
        correlationHClust,
        conversation,
        //conversationstats,
      ] = a;

      assertExists(mathResult, "base-clusters");
      assertExists(mathResult, "consensus");
      assertExists(mathResult, "group-aware-consensus");
      assertExists(mathResult, "group-clusters");
      assertExists(mathResult, "group-votes");
      assertExists(mathResult, "n-cmts");
      assertExists(mathResult, "repness");
      assertExists(mathResult, "pca");
      assertExists(mathResult, "tids");
      assertExists(mathResult, "user-vote-counts");
      assertExists(mathResult, "votes-base");
      assertExists(mathResult.pca, "center");
      assertExists(mathResult.pca, "comment-extremity");
      assertExists(mathResult.pca, "comment-projection");
      assertExists(mathResult.pca, "comps");

      let indexToTid = mathResult.tids;

      // # ptpts that voted
      var ptptCountTotal = conversation.participant_count;


      // # ptpts that voted enough to be included in math
      var ptptCount = 0;
      _.each(mathResult["group-votes"], (val, key) => {
        ptptCount += val["n-members"];
      });

      var badTids = {};
      var filteredTids = {};
      var filteredProbabilities = {};

      // prep Correlation matrix.
      if (globals.enableMatrix) {
        var probabilities = correlationHClust.matrix;
        var tids =  correlationHClust.comments;
        for (let row = 0; row < probabilities.length; row++) {
          if (probabilities[row][0] === "NaN") {
            let tid = correlationHClust.comments[row];
            badTids[tid] = true;
            // console.log("bad", tid);
          }
        }
        filteredProbabilities = probabilities.map((row) => {
          return row.filter((cell, colNum) => {
            let colTid = correlationHClust.comments[colNum];
            return badTids[colTid] !== true;
          });
        }).filter((row, rowNum) => {
            let rowTid = correlationHClust.comments[rowNum];
            return badTids[rowTid] !== true;
        });
        filteredTids = tids.filter((tid, index) => {
          return badTids[tid] !== true;
        });
      }

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
        // return '#' + pad(""+tid, tidWidth);
        return pad(""+tid, tidWidth);
      }

      let repfulAgreeTidsByGroup = {};
      let repfulDisageeTidsByGroup = {};
      if (mathResult.repness) {
        _.each(mathResult.repness, (entries, gid) => {
          entries.forEach((entry) => {
            if (entry['repful-for'] === 'agree') {
              repfulAgreeTidsByGroup[gid] = repfulAgreeTidsByGroup[gid] || [];
              repfulAgreeTidsByGroup[gid].push(entry.tid);
            } else if (entry['repful-for'] === 'disagree') {
              repfulDisageeTidsByGroup[gid] = repfulDisageeTidsByGroup[gid] || [];
              repfulDisageeTidsByGroup[gid].push(entry.tid);
            }
          });
        });
      }

      // ====== REMEMBER: gid's start at zero, (0, 1, 2) but we show them as group 1, 2, 3 in participation view ======
      let groupNames = {};
      for (let i = 0; i <= 9; i++) {
        let label = report["label_group_" + i];
        if (label) {
          groupNames[i] = label;
        }
      }

      let uncertainty = [];
      let unanimity = [];

      let maxCount = _.reduce(comments, (memo, c) => { return Math.max(c.count, memo);}, 1);
      comments.map((c) => {
        var unc = c.pass_count / c.count
        if (unc > .3) {
          c.unc = unc;
          uncertainty.push(c);
        }
      });
      uncertainty.sort((a, b) => {
          return (b.unc*b.unc*b.pass_count - a.unc*a.unc*a.pass_count);
      });
      uncertainty = uncertainty.slice(0, 5);

      let extremity = {};
      _.each(mathResult.pca["comment-extremity"], function(e, index) {
        extremity[indexToTid[index]] = e;
      });

      var uniqueCommenters = {};
      var voteTotals = DataUtils.getVoteTotals(mathResult);
      comments = comments.map((c) => {
        c["group-aware-consensus"] = mathResult["group-aware-consensus"][c.tid];
        uniqueCommenters[c.pid] = 1;
        c = Object.assign(c, voteTotals[c.tid]);
        return c;
      });
      var numUniqueCommenters = _.keys(uniqueCommenters).length;
      var totalVotes = _.reduce(_.values(mathResult["user-vote-counts"]), function(memo, num) {
        return memo + num;
      }, 0);
      const computedStats = {
        votesPerVoterAvg: totalVotes / ptptCountTotal,
        commentsPerCommenterAvg: comments.length / numUniqueCommenters,
      };


      this.setState({
        loading: false,
        math: mathResult,
        consensus: mathResult.consensus,
        extremity: extremity,
        uncertainty: uncertainty.map((c) => {return c.tid;}),
        comments: comments,
        demographics: groupDemographics,
        participants: participants,
        conversation: conversation,
        ptptCount: ptptCount,
        ptptCountTotal: ptptCountTotal,
        filteredCorrelationMatrix: filteredProbabilities,
        filteredCorrelationTids: filteredTids,
        badTids: badTids,
        groupNames: groupNames,
        repfulAgreeTidsByGroup: repfulAgreeTidsByGroup,
        repfulDisageeTidsByGroup: repfulDisageeTidsByGroup,
        formatTid: formatTid,
        report: report,
        //conversationStats: conversationstats,
        computedStats: computedStats,
        nothingToShow: !comments.length || !groupDemographics.length
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

    setInterval(() => {
      if (this.state.shouldPoll) {
        this.getData();
      }
    }, 20 * 1000);

    window.addEventListener("resize", _.throttle(() => {
      this.setState({
        dimensions: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      })
    }, 500));
  }

  onAutoRefreshEnabled() {
    this.setState({
      shouldPoll: true,
    });
  }

  onAutoRefreshDisabled() {
    this.setState({
      shouldPoll: false,
    });
  }

  handleColorblindModeClick () {
    var colorBlind = !this.state.colorBlindMode;
    if (colorBlind) {
      this.setState({
        colorBlindMode: colorBlind,
        voteColors: Object.assign(this.state.voteColors, {
          agree: globals.brandColors.agreeColorblind,
        }),
      });
    } else {
      this.setState({
        colorBlindMode: colorBlind,
        voteColors: Object.assign(this.state.voteColors, {
          agree: globals.brandColors.agree,
        }),
      });
    }
  }

  render() {
    if (this.state.error) {
      return (<div>
        <div> Error Loading </div>
        <div> {this.state.errorText} </div>
        {this.state.errorLink ? (<a href={this.state.errorLink}>{this.state.errorLinkText}</a>) : ""}
      </div>);
    }
    if (this.state.nothingToShow) {
      return (<div>
        <div> Nothing to show yet </div>
      </div>);
    }
    if (this.state.loading) {
      return (<div>
        <div> Loading ... </div>
      </div>);
    }
    console.log('top level app state and props', this.state, this.props)
    return (
      <div style={{margin: "0px 10px"}}>
        <Heading conversation={this.state.conversation}/>
        <div style={{
            marginLeft: 20,
            marginTop: 40,
          }}>
          <Controls
            onAutoRefreshEnabled={this.onAutoRefreshEnabled.bind(this)}
            handleColorblindModeClick={this.handleColorblindModeClick.bind(this)}
            colorBlindMode={this.state.colorBlindMode}
            onAutoRefreshDisabled={this.onAutoRefreshDisabled.bind(this)}
            autoRefreshEnabled={this.state.shouldPoll}
            voteColors={this.state.voteColors}/>

          {/* This may eventually need to go back in below */}
          {/* stats={this.state.conversationStats} */}
          <Overview
            computedStats={this.state.computedStats}
            math={this.state.math}
            comments={this.state.comments}
            ptptCount={this.state.ptptCount}
            ptptCountTotal={this.state.ptptCountTotal}
            demographics={this.state.demographics}
            conversation={this.state.conversation}
            voteColors={this.state.voteColors}/>
          <Beeswarm
            conversation={this.state.conversation}
            extremity={this.state.extremity}
            math={this.state.math}
            comments={this.state.comments}
            probabilities={this.state.filteredCorrelationMatrix}
            probabilitiesTids={this.state.filteredCorrelationTids}
            voteColors={this.state.voteColors}/>
          {/*
            <p style={globals.primaryHeading}>Consensus</p>
            <p style={globals.primaryHeading}>Inclusive Majority</p>
          */}
          <MajorityStrict
            math={this.state.math}
            conversation={this.state.conversation}
            ptptCount={this.state.ptptCount}
            comments={this.state.comments}
            formatTid={this.state.formatTid}
            consensus={this.state.consensus}
            voteColors={this.state.voteColors}/>
          <ParticipantGroups
            comments={this.state.comments}
            conversation={this.state.conversation}
            demographics={this.state.demographics}
            comments={this.state.comments}
            ptptCount={this.state.ptptCount}
            groupNames={this.state.groupNames}
            formatTid={this.state.formatTid}
            math={this.state.math}
            badTids={this.state.badTids}
            repfulAgreeTidsByGroup={this.state.repfulAgreeTidsByGroup}
            repfulDisageeTidsByGroup={this.state.repfulDisageeTidsByGroup}
            report={this.state.report}
            voteColors={this.state.voteColors}/>
          <Uncertainty
            math={this.state.math}
            comments={this.state.comments}
            uncertainty={this.state.uncertainty}
            conversation={this.state.conversation}
            ptptCount={this.state.ptptCount}
            formatTid={this.state.formatTid}
            voteColors={this.state.voteColors}/>
          {false ? <CommentsGraph
            comments={this.state.comments}
            groupNames={this.state.groupNames}
            badTids={this.state.badTids}
            formatTid={this.state.formatTid}
            repfulAgreeTidsByGroup={this.state.repfulAgreeTidsByGroup}
            math={this.state.math}
            renderHeading={true}
            report={this.state.report}
            voteColors={this.state.voteColors}/> : null}
          {globals.enableMatrix && false ? <Matrix
            probabilities={this.state.filteredCorrelationMatrix}
            comments={this.state.comments}
            tids={this.state.filteredCorrelationTids}
            formatTid={this.state.formatTid}
            ptptCount={this.state.ptptCount}
            voteColors={this.state.voteColors}/> : ""}
          <ParticipantsGraph
            comments={this.state.comments}
            groupNames={this.state.groupNames}
            badTids={this.state.badTids}
            colorBlindMode={this.state.colorBlindMode}
            formatTid={this.state.formatTid}
            repfulAgreeTidsByGroup={this.state.repfulAgreeTidsByGroup}
            math={this.state.math}
            renderHeading={true}
            report={this.state.report}
            voteColors={this.state.voteColors}/>
          {/* <BoxPlot
            groupVotes={this.state.math["group-votes"]}/>*/}
          <AllCommentsModeratedIn
            math={this.state.math}
            comments={this.state.comments}
            conversation={this.state.conversation}
            ptptCount={this.state.ptptCount}
            formatTid={this.state.formatTid}
            voteColors={this.state.voteColors}/>
          <Footer/>
        </div>
      </div>
    );
  }
}

export default App;

window.$ = $;
