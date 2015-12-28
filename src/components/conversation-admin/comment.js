import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "../framework/flex";
import Button from "../framework/moderate-button";

const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}

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
      <div style={styles.card}>
        <Flex
          justifyContent="space-between"
          align={"top"}>
          <Flex.Item small={2}>{ this.props.comment.txt }</Flex.Item>
          <Flex>
            { this.props.acceptButton ? this.makeAcceptButton() : "" }
            { this.props.rejectButton ? this.makeRejectButton() : "" }
          </Flex>
        </Flex>
      </div>
    );
  }
}

export default Comment;

/*
  todo
    show stats per comment
    sort by number of votes time submitted etc
*/