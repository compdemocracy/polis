import React from "react";
// import { connect } from "react-redux";
import probabilities from "../sampleData/probabilities";

import Radium from "radium";
import _ from "lodash";

import Report from "./report";

import net from "../util/net"

import $ from 'jquery';

var conversation_id = "2arcefpshi";

@Radium
class App extends React.Component {


  getAgreeMatrix() {
    net.polisGet("/api/v3/voteProbabilityMatrixAgree", {
      conversation_id: conversation_id,
    }).then((result) => {
      // debugger;
      // result = result && result.map((row, i) => {
      //   row.key = i;
      //   return row;
      // });

      this.setState({
        probabilitiesAgree: result.matrix,
        probabilitiesAgreeTids: result.rowToTid,
      });
    }, (err) => {
      this.setState({
        probabilitiesAgreeError: err || true,
      });
    });
  }

  componentWillMount() {
    this.getAgreeMatrix();
  }

  render() {
    return <Report probabilities={this.state.probabilitiesAgree} tids={this.state.probabilitiesAgreeTids} error={this.state.probabilitiesAgreeError}/>;
  }
}

export default App;

window.$ = $;
