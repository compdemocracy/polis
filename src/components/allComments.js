import React from "react";
import _ from "lodash";
import * as globals from "./globals";
import style from "../util/style";

const BarChartCompact = ({comment, groupVotes, }) => {

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
    <svg width={w+ 100} height={10} style={{marginRight: 20}}>
      <g>
        <rect x={0} width={w + 0.5} height={10} fill={"white"} stroke={"rgb(180,180,180)"} />
        <rect x={.5} width={agree} y={.5} height={9} fill={globals.brandColors.agree} />
        <rect x={.5 + agree} width={disagree} y={.5} height={9} fill={globals.brandColors.disagree} />
        <rect x={.5 + agree + disagree} width={pass} y={.5} height={9} fill={globals.brandColors.pass} />
      </g>
    </svg>
  )
};

const CommentRow = ({comment, groups}) => {

    // const percentAgreed = Math.floor(groupVotesForThisGroup.votes[comment.tid].A / groupVotesForThisGroup.votes[comment.tid].S * 100);

    let BarCharts = [];

    _.forEach(groups, (g, i) => {
      console.log('g',g)
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
          flexDirection: "row",
          justifyContent: "flex-start",
          alignItems: "center",
          padding: "6px 10px",
          borderBottom: "1px solid rgb(200,200,200)",
        }}>
        <span style={{
            fontSize: 12,
            width: 300,
            marginRight: 20,
            display: "inline-block",
            textAlign: "auto ",
          }}>
          { comment.txt }
        </span>
        {BarCharts}
      </div>
    );
}


class AllComments extends React.Component {
  render() {

    const comments = _.keyBy(this.props.comments, "tid");
    console.log(this.props)

    return (
      <div>
        <p style={globals.primaryHeading}> All Comments </p>
        <p style={globals.paragraph}>
          This is a list of the {this.props.comments.length} comments that were accepted into the conversation by moderators.
        </p>
        <div style={{marginBottom: 1, borderBottom: "2px solid black"}}>
          <span style={{
            width: 300,
            marginRight: 30, /* the 10 in padding from the cells */
            display: "inline-block",
            fontWeight: 700,
            fontSize: 14,
            textTransform: "uppercase"
          }}>Comment</span>

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


//
// <span style={{
//   width: 70,
//   marginRight: 20,
//   display: "inline-block",
//   fontWeight: 700,
//   fontSize: 14,
//   textTransform: "uppercase"
// }}>
//   # VOTED
// </span>
// <span style={{
//   width: 70,
//   marginRight: 20,
//   display: "inline-block",
//   fontWeight: 700,
//   fontSize: 14,
//   textTransform: "uppercase"
// }}>
//   # AGREED
// </span>
// <span style={{
//   width: 70,
//   marginRight: 20,
//   display: "inline-block",
//   fontWeight: 700,
//   fontSize: 14,
//   textTransform: "uppercase"
// }}>
//   % AGREED
// </span>
