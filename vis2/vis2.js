
import _ from "lodash";
import Graph from "./components/Graph";
import React from 'react';
import ReactDOM from 'react-dom';

// React Router
// import { Router, Route, Link, IndexRoute, browserHistory } from 'react-router';
// React Redux
// import { Provider, connect } from 'react-redux';
// Redux Devtools

// import configureStore from "./store";

// controller view
// import App from "./components/app";

// const store = configureStore();




class Root extends React.Component {
  render() {

    let comments = this.props.comments;

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

    let mathResult = this.props.math_main;
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

    let badTids = _.keyBy(this.props.math_main['mod-out']);

    let ptptois = this.props.ptptois;
    ptptois = _.values(ptptois);
    ptptois = _.keyBy(ptptois, "bid");

    comments = comments.filter((c) => {
      return !c.is_meta;
    });


    return (
      <div>
        <Graph
          comments={comments}
          groupNames={{}}
          badTids={badTids}
          formatTid={formatTid}
          tidsToShow={this.props.tidsToShow}
          ptptois={ptptois}
          repfulAgreeTidsByGroup={repfulAgreeTidsByGroup}
          math={this.props.math_main}
          renderHeading={false}
          votesByMe={this.props.votesByMe}
          onVoteClicked={this.props.onVoteClicked}
          report={{}}/>
      </div>

    );
  }
}
        // <App/>

/*
// for material ui
import injectTapEventPlugin from "react-tap-event-plugin";

//Needed for onTouchTap
//Can go away when react 1.0 release
//Check this repo:
//https://github.com/zilverline/react-tap-event-plugin
injectTapEventPlugin();
*/


window.renderVis = function(rootEl, props) {
  ReactDOM.render(
    React.createElement(Root, props, null),
    rootEl
  );
}
