// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import { connect } from "react-redux";

@connect((state) => {
  return {
    comments: state.comments,
    math: state.math,
  };
})
@Radium
class SummaryBarchart extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  getStyles() {
    return {
      base: {},
    };
  }
  barchart() {
    const math = this.props.math.math;
    const comments = this.props.comments.comments;

    return _.map(math["group-votes"], (votes, i) => {
      console.log(votes);
      return (
        <div>
          <p>
            <span
              style={{
                backgroundColor: "rgb(240,240,240)",
                padding: "3px 6px",
                borderRadius: 3,
                color: "rgb(170,170,170)",
                fontWeight: 300,
              }}
            >
              {" "}
              Group {++i}:
            </span>
            <span style={{ fontWeight: 300 }}>
              {` ${votes.votes[this.props.tid].A} agreed & `}
              {`${votes.votes[this.props.tid].D} disagreed`}
            </span>
          </p>
        </div>
      );
    });
  }
  render() {
    const math = this.props.math.math;
    const styles = this.getStyles();
    return (
      <div style={[styles.base, this.props.style]}>
        {math && !this.props.math.loading && !this.props.comments.loading ? this.barchart() : ""}
      </div>
    );
  }
}

export default SummaryBarchart;
