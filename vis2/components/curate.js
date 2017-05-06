import _ from "lodash";
import React from "react";
import * as globals from "./globals";

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
        <button>X</button>
        <button>Y</button>
        <p> Group: </p>
        <button>A</button>
        <button>B</button>
        <button>C</button>
        <button>D</button>
        <button>Majority Opinion</button>
        <button>My votes</button>
        <button>All comments</button>
      </div>
    )
  }
}


export default Curate;
