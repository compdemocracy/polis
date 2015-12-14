import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";

// @connect(state => state.data)
@Radium
class Comment extends React.Component {
  onAcceptClicked() {
    this.props.acceptClickHandler(this.props.comment)
  }
  onRejectClicked() {
    this.props.rejectClickHandler(this.props.comment)
  }
  makeAcceptButton() {
    return (
      <button onClick={this.onAcceptClicked.bind(this)}> accept </button>
    )
  }
  makeRejectButton() {
    return (
      <button onClick={this.onRejectClicked.bind(this)}> reject </button>
    )
  }
  render() {
    return (
      <div>
        <p>
          { this.props.comment.txt }
          { this.props.acceptButton ? this.makeAcceptButton() : "" }
          { this.props.rejectButton ? this.makeRejectButton() : "" }
        </p>
      </div>
    );
  }
}

export default Comment;
