import React from "react";
import Radium from "radium";
import Flex from "./flex";
// import ParticipantHeader from "./participant-header";
import { connect } from "react-redux";
import * as globals from "./globals";

@Radium
class Comment extends React.Component {
  static propTypes = {
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    acceptButton: React.PropTypes.bool,
    rejectButton: React.PropTypes.bool,
    acceptClickHandler: React.PropTypes.func,
    rejectClickHandler: React.PropTypes.func,
  }
  getStyles() {
    return {

    }
  }
  getDate() {
    const date = new Date(+this.props.comment.created);
    return `${date.getMonth()+1} / ${date.getUTCDate()} / ${date.getFullYear()}`
  }
  getVoteBreakdown(comment) {
    if (typeof this.props.comment.agree_count !== "undefined") {
      return <span>({this.props.comment.agree_count} agreed, {this.props.comment.disagree_count} disagreed, {this.props.comment.pass_count} passed)</span>;
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
        percent: this.props.comment.count / this.props.conversation.participant_count * 100,
        fill: "rgb(180,180,180)"
      },
      {
        label: "agreed",
        percent: this.props.comment.agree_count / this.props.comment.count * 100,
        fill: "rgb(46, 204, 113)"
      },
      {
        label: "disagreed",
        percent: this.props.comment.disagree_count / this.props.comment.count * 100,
        fill: "rgb(231, 76, 60)"
      },
      {
        label: "passed",
        percent: this.props.comment.pass_count / this.props.comment.count * 100,
        fill: "rgb(230,230,230)"
      }
    ];
    return (
      <g>
        {arr.map((d, i) => {
          return (
            <g key={i}>
              <text x={leftTextOffset} y={(i+1) * 15} fontFamily="Helvetica" fontSize="10" textAnchor={"end"}>
                {d.label}
              </text>
              <rect
                width={d.percent}
                height={barHeight}
                x={rectStartX}
                y={((i+1) * 15) - 9}
                fill={d.fill}/>
              <text x={leftTextOffset + d.percent + 10} y={(i+1) * 15} fontFamily="Helvetica" fontSize="10" textAnchor={"start"}>
                {Math.floor(d.percent) + "%"}
              </text>
            </g>
          )
        })}
      </g>
    )
  }
  render() {
    const styles = this.getStyles();
    const showAsAnon = !this.props.comment.social || this.props.comment.anon || this.props.comment.is_seed;

    return (
      <Flex
        styleOverrides={{
          width: "100%",
          marginBottom: 20,
          background: this.props.index % 2 !== 0 ? "none" : "none"
        }}
        direction="row"
        justifyContent="flex-start"
        alignItems={"flex-start"}>
        <Flex alignItems="baseline" justifyContent="flex-start" styleOverrides={{width: globals.paragraphWidth}}>
          <span style={{
              width: 40,
              textAlign: "right",
              marginRight: 10
            }}>#{this.props.comment.tid}</span>
          <span style={styles.commentBody}>{ this.props.comment.txt }</span>
        </Flex>
        <svg width={250} height={70}>
          <line
            x1="120"
            y1="0"
            x2="120"
            y2="65"
            strokeWidth="2"
            stroke="rgb(245,245,245)"/>
          {this.createBarChart()}
        </svg>
      </Flex>
    );
  }
}

export default Comment;
//
// {
//   showAsAnon ?
//     "Anonymous" :
//     <ParticipantHeader {...this.props.comment.social} />
// }
