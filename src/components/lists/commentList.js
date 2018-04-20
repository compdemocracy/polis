import React from "react";
import _ from "lodash";
import * as globals from "../globals";
import style from "../../util/style";
import {VictoryScatter, VictoryChart, VictoryTheme} from "victory";

const BarChartCompact = ({comment, voteCounts, nMembers, voteColors}) => {

  if (!comment) return null;

  let w = 100;

  let agrees = voteCounts.A;
  let disagrees = voteCounts.D;
  let sawTheComment = voteCounts.S;
  let passes = sawTheComment - (agrees + disagrees);
  let totalVotes = agrees + disagrees + passes;

  const agree = agrees / nMembers * w;
  const disagree = disagrees / nMembers * w;
  const pass = passes / nMembers * w;
  const blank = nMembers - sawTheComment / nMembers * w;

  const agreeSaw = agrees / sawTheComment * w;
  const disagreeSaw = disagrees / sawTheComment * w;
  const passSaw = passes / sawTheComment * w;

  const agreeString = (agreeSaw<<0) + "%";
  const disagreeString = (disagreeSaw<<0) + "%";
  const passString = (passSaw<<0) + "%";

  return (
    <div title={agreeString + " Agreed\n" + disagreeString + " Disagreed\n" + passString + " Passed"}>

      <svg width={101} height={10} style={{marginRight: 30}}>
        <g>
          <rect x={0} width={w + 0.5} height={10} fill={"white"} stroke={"rgb(180,180,180)"} />
          <rect x={.5 + agree + disagree} width={pass} y={.5} height={9} fill={voteColors.pass} />
          <rect x={.5} width={agree} y={.5} height={9} fill={voteColors.agree} />
          <rect x={.5 + agree} width={disagree} y={.5} height={9} fill={voteColors.disagree} />
        </g>
      </svg>
      <div>
        <span style={{fontSize: 12, marginRight: 4, color: voteColors.agree}}>{agreeString}</span>
        <span style={{fontSize: 12, marginRight: 4, color: voteColors.disagree}}>{disagreeString}</span>
        <span style={{fontSize: 12, marginRight: 4, color: "#999"}}>{passString}</span>
        <span style={{fontSize: 12, color: "grey"}}>({sawTheComment})</span>
      </div>
      </div>
  )
};

const CommentRow = ({comment, groups, voteColors}) => {

  if (!comment) {
    console.error("WHY IS THERE NO COMMENT 3452354235", comment)
    return null
  }
    // const percentAgreed = Math.floor(groupVotesForThisGroup.votes[comment.tid].A / groupVotesForThisGroup.votes[comment.tid].S * 100);

    let BarCharts = [];
    let totalMembers = 0;

    // groups
    _.forEach(groups, (g, i) => {
      let nMembers = g["n-members"];
      totalMembers += nMembers;
      BarCharts.push(
        <BarChartCompact
            key={i}
            index={i}
            comment={comment}
            voteCounts={g.votes[comment.tid]}
            nMembers={nMembers}
            voteColors={voteColors}
          />
      )
    })

    // totals column
    BarCharts.unshift(
      <BarChartCompact
            key={99}
            index={99}
            comment={comment}
            voteCounts={{
              A: comment.agreed,
              D: comment.disagreed,
              S: comment.saw,
            }}
            nMembers={totalMembers}
            voteColors={voteColors}
          />
    )

    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 0px",
          borderBottom: "1px solid rgb(220,220,220)",
        }}>
        <span style={{
            fontSize: 12,
            width: 20,
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


class CommentList extends React.Component {




  getGroupLabels() {
    function makeLabel(key, label, numMembers) {
      return (<span key={key} style={{
          width: 101,
          marginRight: 30,
          display: "inline-block",
          fontWeight: 400,
          fontSize: 14,
          textTransform: "uppercase"
        }}>
          {label}
          <span style={{
              marginLeft: 5
            }}>
            {numMembers}
          </span>
        </span>);
    }
    let labels = [];


    // totals
    labels.push(makeLabel(99, "Overall", this.props.ptptCount));

    _.each(this.props.math["group-votes"], (g, i) => {
      // console.log(g)
      labels.push(makeLabel(i, globals.groupLabels[i], g["n-members"]))
    })

    return labels;
  }

  render() {

    const comments = _.keyBy(this.props.comments, "tid");

    return (
      <div>
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
          }}>Statement</span>

          {this.getGroupLabels()}
        </div>
        {
          this.props.tidsToRender.map((tid, i) => {
            return <CommentRow
              key={i}
              index={i}
              groups={this.props.math["group-votes"]}
              comment={comments[tid]}
              voteColors={this.props.voteColors}
              />
          })
        }
      </div>
    );
  }
}

export default CommentList;
