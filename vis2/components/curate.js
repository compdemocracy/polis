import _ from "lodash";
import React from "react";
import * as globals from "./globals";

class Curate extends React.Component {

  constructor(props) {
    super(props);
    this.hullElems = [];
    this.Viewer = null;

    this.state = {
      selectedComment: null,
    };
  }

  render () {
    return (
      <div style={{
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <button>All comments</button>
        <button>My votes</button>
        <p> Group: </p>
        <button>A</button>
        <button>B</button>
        <button>C</button>
        <button>D</button>
        <button>Majority Opinion</button>
      </div>
    )
  }
}


export default Curate;
