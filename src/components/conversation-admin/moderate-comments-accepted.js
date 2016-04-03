import React from "react";
import { connect } from "react-redux";
import { populateAcceptedCommentsStore, changeCommentStatusToRejected } from '../../actions';
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";
import Spinner from "../framework/spinner";
import Flex from "../framework/flex";


@connect(state => state.mod_comments_accepted)
@Radium
class ModerateCommentsAccepted extends React.Component {
  onCommentRejected(comment) {
    this.props.dispatch(changeCommentStatusToRejected(comment))
  }
  createCommentMarkup() {
    const comments = this.props.accepted_comments.map((comment, i) => {
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
  renderSpinner() {
    return (
      <Flex>
        <Spinner/>
        <span style={{
            marginLeft: 10,
            position: "relative",
            top: -2
          }}> Loading accepted comments... </span>
      </Flex>
    )
  }
  render() {
    return (
      <div>
        <div>
          {
            this.props.accepted_comments !== null ?
              this.createCommentMarkup() :
              this.renderSpinner()
          }
        </div>
      </div>
    );
  }
}

export default ModerateCommentsAccepted;
