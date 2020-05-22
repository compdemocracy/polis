// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import React from "react";
import Radium from "radium";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import Checkbox from "material-ui/Checkbox";
import ParticipantHeader from "./participant-header";
import { connect } from "react-redux";
import settings from "../../settings";

@connect((state) => {
  return {
    conversation: state.zid_metadata.zid_metadata,
  };
})
@Radium
class Comment extends React.Component {
  getStyles() {
    return {
      card: {
        margin: "10px 20px 10px 20px",
        backgroundColor: "rgb(253,253,253)",
        borderRadius: 3,
        maxWidth: 800,
        padding: 10,
        WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
        BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
      },
      commentBody: {
        maxWidth: 550,
        fontWeight: 300,
        marginLeft: 10,
      },
      info: {
        fontWeight: 300,
        fontSize: 14,
        marginTop: 0,
        marginLeft: 10,
      },
    };
  }
  onAcceptClicked() {
    this.props.acceptClickHandler(this.props.comment);
  }
  onRejectClicked() {
    this.props.rejectClickHandler(this.props.comment);
  }
  onIsMetaClicked() {
    this.props.toggleIsMetaHandler(this.props.comment, this.refs.is_meta.isChecked());
  }
  makeAcceptButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
          marginRight: 20,
        }}
        onClick={this.onAcceptClicked.bind(this)}
      >
        {this.props.acceptButtonText}
      </Button>
    );
  }
  makeRejectButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
        }}
        onClick={this.onRejectClicked.bind(this)}
      >
        {this.props.rejectButtonText}
      </Button>
    );
  }
  getDate() {
    const date = new Date(+this.props.comment.created);
    return `${date.getMonth() + 1} / ${date.getUTCDate()} / ${date.getFullYear()}`;
  }
  getVoteBreakdown(comment) {
    if (typeof this.props.comment.agree_count !== "undefined") {
      return (
        <span>
          ({this.props.comment.agree_count} agreed, {this.props.comment.disagree_count} disagreed,{" "}
          {this.props.comment.pass_count} passed)
        </span>
      );
    }
    return "";
  }
  createBarChart() {
    const rectStartX = 70;
    const barHeight = 12;
    const leftTextOffset = 63;

    const arr = [
      {
        label: "voted",
        percent: this.props.conversation.participant_count
          ? (this.props.comment.count / this.props.conversation.participant_count) * 100
          : 0,
        fill: "rgb(180,180,180)",
      },
      {
        label: "agreed",
        percent: this.props.comment.count
          ? (this.props.comment.agree_count / this.props.comment.count) * 100
          : 0,
        fill: "rgb(46, 204, 113)",
      },
      {
        label: "disagreed",
        percent: this.props.comment.count
          ? (this.props.comment.disagree_count / this.props.comment.count) * 100
          : 0,
        fill: "rgb(231, 76, 60)",
      },
      {
        label: "passed",
        percent: this.props.comment.count
          ? (this.props.comment.pass_count / this.props.comment.count) * 100
          : 0,
        fill: "rgb(230,230,230)",
      },
    ];

    if (!_.isNumber(this.props.comment.agree_count)) {
      return null;
    }

    return (
      <g>
        {arr.map((d, i) => {
          return (
            <g key={i}>
              <text
                x={leftTextOffset}
                y={(i + 1) * 15}
                fontFamily="Helvetica"
                fontSize="10"
                textAnchor={"end"}
              >
                {d.label}
              </text>
              <rect
                width={d.percent}
                height={barHeight}
                x={rectStartX}
                y={(i + 1) * 15 - 9}
                fill={d.fill}
              />
              <text
                x={leftTextOffset + d.percent + 10}
                y={(i + 1) * 15}
                fontFamily="Helvetica"
                fontSize="10"
                textAnchor={"start"}
              >
                {Math.floor(d.percent) + "%"}
              </text>
            </g>
          );
        })}
      </g>
    );
  }
  render() {
    const styles = this.getStyles();
    const showAsAnon =
      !this.props.comment.social || this.props.comment.anon || this.props.comment.is_seed;

    return (
      <div style={styles.card}>
        <Flex direction="column" wrap="wrap" justifyContent="space-between" alignItems={"baseline"}>
          {showAsAnon ? "Anonymous" : <ParticipantHeader {...this.props.comment.social} />}
          <Flex styleOverrides={{ width: "100%" }}>
            <p style={styles.commentBody}>{this.props.comment.txt}</p>
          </Flex>
          <Flex
            justifyContent="space-between"
            alignItems="flex-end"
            styleOverrides={{ width: "100%" }}
          >
            <svg width={250} height={70}>
              <line x1="120" y1="0" x2="120" y2="65" strokeWidth="2" stroke="rgb(245,245,245)" />
              {this.createBarChart()}
            </svg>
            <div>
              {this.props.isMetaCheckbox ? (
                <Checkbox
                  label="metadata"
                  ref="is_meta"
                  checked={this.props.comment.is_meta}
                  onCheck={this.onIsMetaClicked.bind(this)}
                  labelWrapperColor={settings.darkerGray}
                  color={settings.polisBlue}
                />
              ) : (
                ""
              )}
              <div style={{ marginTop: 10 }} />
              {this.props.acceptButton ? this.makeAcceptButton() : ""}
              {this.props.rejectButton ? this.makeRejectButton() : ""}
            </div>
          </Flex>
        </Flex>
      </div>
    );
  }
}

export default Comment;

/*
  todo
    show stats per comment
    sort by number of votes time submitted etc

    <p style={styles.info}>
      Created on
      <span style={{fontWeight: 500}}> {this.getDate()}</span>,
      voted on a total of
      <span style={{fontWeight: 500}}> {this.props.comment.count} </span>
      times.
      {this.getVoteBreakdown(this.props.comment)}
    </p>
*/
