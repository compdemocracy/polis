import React from "react";
import { connect } from "react-redux";
import { populateAcceptedCommentsStore, changeCommentStatusToRejected } from '../../actions';
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";


@connect(state => state.mod_comments_accepted)
@Radium
class ModerateCommentsAccepted extends React.Component {
  onCommentRejected(comment) {
    this.props.dispatch(changeCommentStatusToRejected(comment))
  }
  createCommentMarkup() {
    const comments = this.props.accepted_comments.map((comment, i)=>{
      return (
        <Comment
          key={i}
          rejectButton
          rejectClickHandler={this.onCommentRejected.bind(this)}
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
            this.props.accepted_comments !== null ? this.createCommentMarkup() : "spinnrrrr"
          }
        </div>
      </div>
    );
  }
}

export default ModerateCommentsAccepted;
