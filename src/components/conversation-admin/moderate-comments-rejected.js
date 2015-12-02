import React from "react";
import { connect } from "react-redux";
import { populateRejectedCommentsStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";

@connect(state => state.mod_comments_rejected)
@Radium
class ModerateCommentsRejected extends React.Component {
  loadRejectedComments() {
    this.props.dispatch(
      populateRejectedCommentsStore(this.props.params.conversation)
    )
  }
  componentWillMount () {
    this.loadRejectedComments()
  }
  createCommentMarkup() {
    const comments = this.props.rejected_comments.map((comment, i)=>{
      return (
        <p key={i}> {comment.txt} </p>
      )
    })
    return comments;
  }
  render() {
    return (
      <div>
        <h1>ModerateCommentsRejected</h1>
        <div>
          {
            this.props.rejected_comments !== null ? this.createCommentMarkup() : "spinnrrrr"
          }
        </div>
      </div>
    );
  }
}

export default ModerateCommentsRejected;