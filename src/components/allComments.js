import React from "react";
import _ from "lodash";
import * as globals from "./globals";
import style from "../util/style";
import {VictoryScatter, VictoryChart, VictoryTheme} from "victory";

const BarChartCompact = ({comment, groupVotes}) => {

  if (!comment) return null;

  let w = 100;

  let groupVotesForThisComment = groupVotes.votes[comment.tid];
  let agrees = groupVotesForThisComment.A;
  let disagrees = groupVotesForThisComment.D;
  let sawTheComment = groupVotesForThisComment.S;
  let passes = sawTheComment - (agrees + disagrees);
  let totalVotes = agrees + disagrees + passes;
  let nMembers = groupVotes["n-members"];

  const agree = agrees / nMembers * w;
  const disagree = disagrees / nMembers * w;
  const pass = passes / nMembers * w;
  const blank = nMembers - sawTheComment / nMembers * w;

  return (
    <svg width={101} height={10} style={{marginRight: 30}}>
      <g>
        <rect x={0} width={w + 0.5} height={10} fill={"white"} stroke={"rgb(180,180,180)"} />
        <rect x={.5 + agree + disagree} width={pass} y={.5} height={9} fill={globals.brandColors.pass} />
        <rect x={.5} width={agree} y={.5} height={9} fill={globals.brandColors.agree} />
        <rect x={.5 + agree} width={disagree} y={.5} height={9} fill={globals.brandColors.disagree} />
      </g>
    </svg>
  )
};

const CommentRow = ({comment, groups}) => {

    if (comment.is_meta) return null

    // const percentAgreed = Math.floor(groupVotesForThisGroup.votes[comment.tid].A / groupVotesForThisGroup.votes[comment.tid].S * 100);

    let BarCharts = [];

    _.forEach(groups, (g, i) => {
      BarCharts.push(
        <BarChartCompact
            key={i}
            index={i}
            comment={comment}
            groupVotes={g}
          />
      )
    })


    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 0px",
          borderBottom: "1px solid rgb(200,200,200)",
        }}>
        <span style={{
            fontSize: 12,
            width: 10,
            marginRight: 10,
          }}>
           {comment.tid}
        </span>

        <span style={{
            fontSize: 12,
            width: 200,
            marginRight: 50,
          }}>
           { comment.txt }
        </span>
        {BarCharts}
      </div>
    );
}


class AllComments extends React.Component {

  getGroupLabels() {

    let labels = [];

    _.each(this.props.math["group-votes"], (g, i) => {
      // console.log(g)
      labels.push(
        <span key={i} style={{
          width: 101,
          marginRight: 30,
          display: "inline-block",
          fontWeight: 700,
          fontSize: 14,
          textTransform: "uppercase"
        }}>
          {globals.groupLabels[i]} <span style={{fontWeight: 300, fontStyle: "italic", marginLeft: 5}}>{g["n-members"]}</span>
        </span>
      )
    })

    return labels;
  }

  render() {

    const comments = _.keyBy(this.props.comments, "tid");

    return (
      <div>
        <p style={globals.primaryHeading}> All Comments </p>

        <p style={globals.paragraph}>
          This is a list of the {this.props.comments.length} comments that were accepted into the conversation by moderators.
        </p>
        <div style={{
            marginBottom: 1,
          }}>
        </div>
        <div style={{
            marginBottom: 1,
            borderBottom: "2px solid black",
            position: "relative",
          }}>
          <span style={{
            minWidth: 200,
            marginRight: 50 + 10 + 33, /* the 10 in padding from the cells, the 33 for offset group labels */
            display: "inline-block",
            fontWeight: 700,
            fontSize: 14,
            textTransform: "uppercase"
          }}>Comment</span>
          <span style={{
            position: "absolute",
            top: 2,
            left: 200 + 30, /* the 10 in padding from the cells, the 45 for offset group labels */
            fontStyle: "italic",
            fontWeight: 300,
            fontSize: 14,
          }}>Group:</span>
          {this.getGroupLabels()}
        </div>
        {
          this.props.comments.slice().reverse().map((c, i) => {
            return <CommentRow
              key={i}
              index={i}
              groups={this.props.math["group-votes"]}
              comment={comments[c.tid]}
              />
          })
        }
      </div>
    );
  }
}

export default AllComments;
