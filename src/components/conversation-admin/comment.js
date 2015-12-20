import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "../framework/flex";
import Button from "../framework/moderate-button";

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
      <Button onClick={this.onAcceptClicked.bind(this)}> accept </Button>
    )
  }
  makeRejectButton() {
    return (
      <Button onClick={this.onRejectClicked.bind(this)}> reject </Button>
    )
  }
  render() {
    return (
      <div style={{marginBottom: 30}}>
      <Flex
        justifyContent="space-between"
        align={"baseline"}>
        <Flex.Item small={2}>{ this.props.comment.txt }</Flex.Item>
        <Flex.Item small={3}>
          { this.props.acceptButton ? this.makeAcceptButton() : "" }
          { this.props.rejectButton ? this.makeRejectButton() : "" }
        </Flex.Item>
      </Flex>
      </div>
    );
  }
}

export default Comment;
