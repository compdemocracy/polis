import React from "react";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";


function sortByTid(comments) {
  return _.map(comments, (comment) => comment.tid).sort((a, b) => a - b);
}

function sortByVoteCount(comments) {
  return _.map(_.reverse(_.sortBy(comments, "count")), (c) => {return c.tid;});
}
function sortByGroupAwareConsensus(comments) {
  return _.map(_.reverse(_.sortBy(comments, (c) => {return c["group-aware-consensus"] && c["group-aware-consensus"].total;})), (c) => {return c.tid;});
}

class allCommentsModeratedIn extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      sortStyle: globals.allCommentsSortDefault,
    };
  }

  onSortChanged(event) {
    this.setState({
      sortStyle: event.target.value,
    });
  }

  render() {

    if (!this.props.conversation) {
      return <div>Loading allCommentsModeratedIn...</div>
    }

    let sortFunction = null;
    if (this.state.sortStyle === "tid") {
      sortFunction = sortByTid;
    } else if (this.state.sortStyle === "numvotes") {
      sortFunction = sortByVoteCount;
    } else if (this.state.sortStyle === "consensus") {
      sortFunction = sortByGroupAwareConsensus;
    } else {
      console.error('missing sort function', this.state.sortStyle);
    }

    return (
      <div>
        <p style={globals.primaryHeading}> All comments </p>
        <p style={globals.paragraph}>
          Group votes across all comments, excluding those comments which were moderated out.
        </p>
        <label for="allCommentsSortMode">Sort by: </label>
        <select id="allCommentsSortMode" onChange={this.onSortChanged.bind(this)} value={this.state.sortStyle}>
          <option value="tid">Comment Id</option>
          <option value="consensus">Consensus</option>
          <option value="numvotes">Number of votes</option>
        </select>
        <div style={{marginTop: 50}}>
          <CommentList
            conversation={this.props.conversation}
            ptptCount={this.props.ptptCount}
            math={this.props.math}
            formatTid={this.props.formatTid}
            tidsToRender={sortFunction(this.props.comments)}
            comments={this.props.comments}/>
        </div>
      </div>
    );
  }
};

export default allCommentsModeratedIn;
