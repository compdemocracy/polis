import React from "react";
import { connect } from "react-redux";
import { populateRejectedCommentsStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";

@connect(state => state.mod_comments_rejected)
@Radium
class ModerateCommentsRejected extends React.Component {
  createCommentMarkup() {
    const comments = this.props.rejected_comments.map((comment, i)=>{
      return (
        <Comment
          key={i}
          comment={comment}/>
      )
    })
    return comments;
  }
  render() {
    return (
      <div>
        <div>
          {
            this.props.rejected_comments !== null ? this.createCommentMarkup() : "Loading rejected comments..."
          }
        </div>
      </div>
    );
  }
}

export default ModerateCommentsRejected;
