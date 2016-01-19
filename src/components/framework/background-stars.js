import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import {particles} from "./connected-particles";

@Radium
class BackgroundStars extends React.Component {

  componentDidMount () {

  }

  render() {
    const width = window.innerWidth;
    const starCount = Math.floor(window.innerWidth / 20);
    /* any content above the stars must have position relative and zindex > 1 */
    return (
      <div style={{zIndex: 1}}>
        <canvas
          style={{
            position: "fixed",
            top: 0,
            left: 0,
          }}
          width={window.innerWidth}
          height={window.innerHeight / 2}>
        </canvas>
        {
          particles({
            color: "rgba(255,255,255,1)",
            count: starCount,
            radius: 1.5,
            lineWidth: 1
          })
        }
      </div>
    );
  }
}

export default BackgroundStars;