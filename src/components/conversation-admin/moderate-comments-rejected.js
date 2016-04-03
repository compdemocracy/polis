import React from "react";
import { connect } from "react-redux";
import { populateRejectedCommentsStore } from '../../actions'
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";
import Spinner from "../framework/spinner";
import Flex from "../framework/flex";

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
  renderSpinner() {
    return (
      <Flex>
        <Spinner/>
        <span style={{
            marginLeft: 10,
            position: "relative",
            top: -2
          }}> Loading rejected comments... </span>
      </Flex>
    )
  }
  render() {
    return (
      <div>
        <div>
          {
            this.props.rejected_comments !== null ?
              this.createCommentMarkup() :
              this.renderSpinner()
          }
        </div>
      </div>
    );
  }
}

export default ModerateCommentsRejected;
