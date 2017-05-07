import _ from "lodash";
import React from "react";
import * as globals from "./globals";

class Button extends React.Component {
  render () {
    return (
      <button style={{
        border: "none",
        fontSize: 14,
        marginRight: 5,
        cursor: "pointer",
        padding: "6px 12px",
        backgroundColor: (this.props.selectedComment && this.props.selectedComment.tid === c.tid) ? "#03a9f4" : "rgb(235,235,235)",
        color: (this.props.selectedComment && this.props.selectedComment.tid === c.tid) ? "rgb(255,255,255)" : "rgb(100,100,100)",
        borderRadius: 4,
      }}>
        {this.props.children}
      </button>
    )
  }
}

class Curate extends React.Component {

  constructor(props) {
    super(props);

    this.state = {

    };
  }

  render () {
    return (
      <div style={{
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
      }}>
        <div>
          <Button>X</Button>
          <Button>Y</Button>
        </div>
        <div style={{
          display: "flex",
          justifyContent: "flex-start",
          alignItems: "baseline",
        }}>
          <p style={{marginRight: 10, fontWeight: 500}}> Group: </p>
          <Button>A</Button>
          <Button>B</Button>
          <Button>C</Button>
          <Button>D</Button>
        </div>
        <Button>Majority Opinion</Button>
        <Button>My votes</Button>
        <Button>All comments</Button>
      </div>
    )
  }
}


export default Curate;
