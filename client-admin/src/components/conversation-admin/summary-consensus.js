// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import Comment from "./summary-comment";

@Radium
class SummaryConsensus extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      pagination: 0,
    };
  }

  getStyles() {
    return {
      base: {},
      sectionHeader: {
        fontWeight: 500,
        fontSize: 24,
      },
      container: {
        fontWeight: 300,
        maxWidth: 600,
        marginBottom: 70,
      },
      mostAgreedUpon: {
        backgroundColor: "rgb(46, 204, 113)",
        padding: "3px 6px",
        borderRadius: 3,
        color: "white",
      },
      mostDisgreedUpon: {
        backgroundColor: "rgb(231, 76, 60)",
        padding: "3px 6px",
        borderRadius: 3,
        color: "white",
      },
    };
  }
  getConsensusAgreeComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    const styles = this.getStyles();
    return math.consensus.agree.map((comment, i) => {
      return (
        <Comment
          key={i}
          majority={true}
          agree={true}
          first={i === 0 ? true : false}
          {...comment}
          {...comments[comment.tid]}
        />
      );
    });
  }
  getConsensusDisagreeComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    const styles = this.getStyles();
    return math.consensus.disagree.map((comment, i) => {
      return <Comment key={i} majority={true} {...comment} {...comments[comment.tid]} />;
    });
  }
  render() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    const styles = this.getStyles();
    return (
      <div style={styles.container}>
        <p style={styles.sectionHeader}> The General Consensus </p>
        <p>
          Across all {math["n"]} participants,
          {` the `}
          <span style={styles.mostAgreedUpon}>most agreed</span>
          {` upon `}
          {math.consensus.agree.length > 1 ? " comments were: " : "comment was: "}
        </p>
        {this.getConsensusAgreeComments()}
        <p>
          {` The `}
          <span style={styles.mostDisgreedUpon}>most disagreed</span>
          {` upon `}
          {math.consensus.disagree.length > 1 ? " comments were: " : "comment was: "}
        </p>
        {this.getConsensusDisagreeComments()}
      </div>
    );
  }
}

export default SummaryConsensus;
