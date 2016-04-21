import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Flex from "../framework/flex";
// import { connect } from "react-redux";
// import { FOO } from "../actions";
import Comment from "./summary-comment";
import Awesome from "react-fontawesome";

// @connect(state => {
//   return state.FOO;
// })
@Radium
class SummaryGroup extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      pagination: 0,
      showHowOtherGroupsFelt: false
    };
  }
  static propTypes = {
    /* react */
    // dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  getStyles() {
    return {
      numberBadge: {
        backgroundColor: "rgb(140,140,140)",
        padding: "3px 6px",
        borderRadius: 3,
        color: "white",
        fontWeight: 300
      }
    };
  }
  groupComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;

    return this.props.groupComments.map((comment, i) => {
      const groupVotes = math["group-votes"][this.props.repnessIndex].votes[comment.tid];
      const isBestAgree = comment["best-agree"] && (groupVotes && groupVotes.A > 0);
      const agree = isBestAgree || comment["repful-for"] === "agree";
      const percent = agree ?
        Math.floor(groupVotes.A / groupVotes.S * 100) :
        Math.floor(groupVotes.D / groupVotes.S * 100);
      // if (this.state.pagination === i) {
        return (
          <Comment
            key={i}
            showHowOtherGroupsFelt={this.props.showHowOtherGroupsFelt}
            majority={false}
            agree={agree}
            percent={percent}
            {...comment}
            {...comments[comment.tid]}/>
        )
      // }
    })
  }
  render() {
    const styles = this.getStyles();
    const math = this.props.math.math;
    return (
      <div
        style={{
          marginBottom: 70
        }}>
          <p>
            <span style={{fontSize: 18, fontWeight: 100}}>
              {`GROUP ${+this.props.repnessIndex + 1} `}
            </span>
            <span style={{fontSize: 18, fontWeight: 500}}>
              {` • ${math["group-votes"][this.props.repnessIndex]["n-members"]} participants`}
            </span>
          </p>
        {this.groupComments()}
      </div>
    );
  }
}

export default SummaryGroup;

// <Awesome name="users"/>
// {` `}
// {`Group `}
// {``}
// {": "}
// {` participants`}
