import React from "react";
import Radium from "radium";
// import _ from "lodash";
// import Flex from "./framework/flex";
// import { connect } from "react-redux";
// import { FOO } from "../actions";
import Comment from "./summary-comment";

// @connect(state => {
//   return state.FOO;
// })
@Radium
class SummaryGroup extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

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
      base: {

      }
    };
  }
  groupComments() {
    console.log(this.props)
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    return this.props.groupComments.map((comment, i) => {
      let groupVotes = math["group-votes"][this.props.repnessIndex].votes[comment.tid]
      return (
        <Comment
          key={i}
          majority={false}
          agree={comment["repful-for"] === "agree" ? true : false}
          percent={
            comment["repful-for"] === "agree" ?
            Math.floor(groupVotes.A / groupVotes.S * 100) :
            Math.floor(groupVotes.D / groupVotes.S * 100)
          }
          {...comment}
          {...comments[comment.tid]}/>
      )
    })
  }
  render() {
    const styles = this.getStyles();
    const math = this.props.math.math;
    return (
      <span>
        <p>
          {`Group `}
          {`${+this.props.repnessIndex + 1}`}
          {": "}
          {math["group-votes"][this.props.repnessIndex]["n-members"]}
          {` participants`}
        </p>
        {this.groupComments()}
      </span>
    );
  }
}

export default SummaryGroup;
