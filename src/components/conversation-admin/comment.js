import React from "react";
import Radium from "radium";
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
  static propTypes = {
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    acceptButton: React.PropTypes.bool,
    rejectButton: React.PropTypes.bool,
    acceptClickHandler: React.PropTypes.func,
    rejectClickHandler: React.PropTypes.func,
  }
  onAcceptClicked() {
    this.props.acceptClickHandler(this.props.comment)
  }
  onRejectClicked() {
    this.props.rejectClickHandler(this.props.comment)
  }
  makeAcceptButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
          marginTop: 20,
        }}
        onClick={this.onAcceptClicked.bind(this)}>
        accept
      </Button>
    )
  }
  makeRejectButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
          marginTop: 20,
        }}
        onClick={this.onRejectClicked.bind(this)}>
        reject
      </Button>
    )
  }
  render() {
    return (
      <div style={styles.card}>
        <Flex
          justifyContent="space-between"
          align={"top"}>
          <p>{ this.props.comment.txt }</p>
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
