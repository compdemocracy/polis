import React from "react";
import Radium from "radium";
import Flex from "./flex";
// import ParticipantHeader from "./participant-header";
import { connect } from "react-redux";
import * as globals from "./globals";
import BarChart from "./barChart";

@Radium
class ParticipantGroupComment extends React.Component {
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

  render() {
    const styles = this.getStyles();
    const showAsAnon = !this.props.comment.social || this.props.comment.anon || this.props.comment.is_seed;

    return (
      <Flex
        styleOverrides={{
          width: "100%",
          marginBottom: 50,
          background: this.props.index % 2 !== 0 ? "none" : "none"
        }}
        direction="row"
        justifyContent="flex-start"
        alignItems={"flex-start"}>
        <Flex alignItems="baseline" justifyContent="flex-start" styleOverrides={{width: globals.paragraphWidth}}>
          <span style={{
              width: 40,
              textAlign: "right",
              marginRight: 10,
              fontFamily: globals.sans,
              fontWeight: 700,
              color: globals.tidGrey
            }}>#{this.props.comment.tid}</span>
          <span style={[globals.paragraph, {fontStyle: "italic"}]}>{ this.props.comment.txt }</span>
        </Flex>
        <svg width={globals.barChartWidth} height={70}>
          <line
            x1="120"
            y1="0"
            x2="120"
            y2="65"
            strokeWidth="2"
            stroke="rgb(245,245,245)"/>
          <BarChart
            conversation={this.props.conversation}
            comment={this.props.comment}
            ptptCount={this.props.ptptCount}/>
        </svg>
        <svg width={globals.barChartWidth} height={70}>
          <line
            x1="120"
            y1="0"
            x2="120"
            y2="65"
            strokeWidth="2"
            stroke="rgb(245,245,245)"/>
          <BarChart
            groupVotesForThisGroup={this.props.groupVotesForThisGroup}
            conversation={this.props.conversation}
            comment={this.props.comment}
            ptptCount={this.props.ptptCount}/>
        </svg>
      </Flex>
    );
  }
}

export default ParticipantGroupComment;

// <p>{this.props.comment.demographics.gender}</p>
// <p>{this.props.comment.demographics.age}</p>

// {
//   showAsAnon ?
//     "Anonymous" :
//     <ParticipantHeader {...this.props.comment.social} />
// }
