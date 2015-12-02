import React from "react";
import { connect } from "react-redux";
import { populateAcceptedCommentsStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";

@connect(state => state.mod_comments_accepted)
@Radium
class ModerateCommentsAccepted extends React.Component {
  loadAcceptedComments() {
    this.props.dispatch(
      populateAcceptedCommentsStore(this.props.params.conversation)
    )
  }
  componentWillMount () {
    this.loadAcceptedComments()
  }
  createCommentMarkup() {
    const comments = this.props.accepted_comments.map((comment, i)=>{
      return (
        <p key={i}> {comment.txt} </p>
      )
    })
    return comments;
  }
  render() {
    return (
      <div>
        <h1>ModerateCommentsAccepted</h1>
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