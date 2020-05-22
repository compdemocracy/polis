// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import Comment from "./summary-comment";

@Radium
class SummaryGroup extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      pagination: 0,
      showHowOtherGroupsFelt: false,
    };
  }

  getStyles() {
    return {
      numberBadge: {
        backgroundColor: "rgb(140,140,140)",
        padding: "3px 6px",
        borderRadius: 3,
        color: "white",
        fontWeight: 300,
      },
    };
  }
  groupComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;

    return this.props.groupComments.map((comment, i) => {
      const groupVotes = math["group-votes"][this.props.repnessIndex].votes[comment.tid];
      const isBestAgree = comment["best-agree"] && groupVotes && groupVotes.A > 0;
      const agree = isBestAgree || comment["repful-for"] === "agree";
      const percent = agree
        ? Math.floor((groupVotes.A / groupVotes.S) * 100)
        : Math.floor((groupVotes.D / groupVotes.S) * 100);
      return (
        <Comment
          key={i}
          showHowOtherGroupsFelt={this.props.showHowOtherGroupsFelt}
          majority={false}
          agree={agree}
          percent={percent}
          {...comment}
          {...comments[comment.tid]}
        />
      );
    });
  }
  render() {
    const styles = this.getStyles();
    const math = this.props.math.math;
    return (
      <div
        style={{
          marginBottom: 70,
        }}
      >
        <p>
          <span style={{ fontSize: 18, fontWeight: 100 }}>
            {`GROUP ${+this.props.repnessIndex + 1} `}
          </span>
          <span style={{ fontSize: 18, fontWeight: 500 }}>
            {` • ${math["group-votes"][this.props.repnessIndex]["n-members"]} participants`}
          </span>
        </p>
        {this.groupComments()}
      </div>
    );
  }
}

export default SummaryGroup;
