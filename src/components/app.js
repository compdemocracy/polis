import React from "react";
// import { connect } from "react-redux";
import probabilities from "../sampleData/probabilities";
import covariance from "../sampleData/covariance";
// import correlation from "../sampleData/correlation";
// import correlationHClust from "../sampleData/correlationHClust"
import * as globals from "./globals";

import Radium from "radium";
import _ from "lodash";

import Matrix from "./Matrix";
import Heading from "./Heading";
import Footer from "./Footer";
import Overview from "./Overview";
import Consensus from "./Consensus";
import Uncertainty from "./Uncertainty";
import AllComments from "./AllComments";
import ParticipantGroups from "./ParticipantGroups";
import Graph from "./Graph";
import BoxPlot from "./boxPlot/boxPlot";

import net from "../util/net"

import $ from 'jquery';

var pathname = window.location.pathname; // "/report/2arcefpshi"
var report_id = pathname.split("/")[2];


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
      dimensions: {
        width: window.innerWidth,
        height: window.innerHeight
      }
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
      include_social: true,
      include_demographics: true
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

  // getConversationStats(conversation_id) {
  //   return net.polisGet("/api/v3/conversationStats", {
  //     conversation_id: conversation_id
  //   });
  // }

  getCorrelationMatrix(math_tick) {
    const attemptResponse = net.polisGet("/api/v3/math/correlationMatrix", {
      math_tick: math_tick,
      report_id: report_id,
    });

    return new Promise((resolve, reject) => {
      attemptResponse.then((response) => {
        if (response.status && response.status === "pending") {
          setTimeout(() => {
            this.getCorrelationMatrix(math_tick).then(resolve, reject);
          }, 500);
        } else if (response.status && response.status === "polis_report_needs_comment_selection") {
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
    // const conversationStatsPromise = reportPromise.then((report) => {
    //   return this.getConversationStats(report.conversation_id)
    // })
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
      // conversationStatsPromise,
    ]).then((a) => {
      console.log('a:', a)
      const [
        report,
        mathResult,
        comments,
        groupDemographics,
        participants,
        correlationHClust,
        conversation,
      ] = a;

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
        return '#' + pad(""+tid, tidWidth);
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

      comments.map((c) => {
        if (c.pass_count / c.count > .3) {
          uncertainty.push(c.tid)
        }
      })

      this.setState({
        loading: false,
        math: mathResult,
        consensus: mathResult.consensus,
        uncertainty: uncertainty,
        comments: comments,
        demographics: groupDemographics,
        participants: participants,
        conversation: conversation,
        ptptCount: ptptCount,
        filteredCorrelationMatrix: filteredProbabilities,
        filteredCorrelationTids: filteredTids,
        badTids: badTids,
        groupNames: groupNames,
        repfulAgreeTidsByGroup: repfulAgreeTidsByGroup,
        repfulDisageeTidsByGroup: repfulDisageeTidsByGroup,
        formatTid: formatTid,
        report: report,
        nothingToShow: !comments.length || !groupDemographics.length,
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
          <BoxPlot
            groupVotes={this.state.math["group-votes"]}/>
          <Overview
            math={this.state.math}
            comments={this.state.comments}
            ptptCount={this.state.ptptCount}
            demographics={this.state.demographics}
            conversation={this.state.conversation}/>
          <AllComments
            conversation={this.state.conversation}
            ptptCount={this.state.ptptCount}
            math={this.state.math}
            formatTid={this.state.formatTid}
            comments={this.state.comments}/>
          <Consensus
            conversation={this.state.conversation}
            ptptCount={this.state.ptptCount}
            comments={this.state.comments}
            formatTid={this.state.formatTid}
            consensus={this.state.consensus}/>
          {globals.enableMatrix ? <Matrix
            title={"Correlation matrix"}
            probabilities={this.state.filteredCorrelationMatrix}
            comments={this.state.comments}
            tids={this.state.filteredCorrelationTids}
            formatTid={this.state.formatTid}
            ptptCount={this.state.ptptCount}/> : ""}
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
            report={this.state.report}/>
          <Uncertainty
            comments={this.state.comments}
            uncertainty={this.state.uncertainty}
            conversation={this.state.conversation}
            ptptCount={this.state.ptptCount}
            formatTid={this.state.formatTid}/>
          <Graph
            comments={this.state.comments}
            groupNames={this.state.groupNames}
            badTids={this.state.badTids}
            formatTid={this.state.formatTid}
            repfulAgreeTidsByGroup={this.state.repfulAgreeTidsByGroup}
            math={this.state.math}
            renderHeading={true}
            report={this.state.report}/>
          <Footer/>
        </div>
      </div>
    );
  }
}

export default App;

window.$ = $;
