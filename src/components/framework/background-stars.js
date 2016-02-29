import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import {particles} from "./connected-particles";

@Radium
class BackgroundStars extends React.Component {
  static defaultProps = {
    color: "rgba(255,255,255,1)",
    count: Math.floor(window.innerWidth / 20),
    width: window.innerWidth,
    height: window.innerHeight / 2
  }

  render() {
    /* any content above the stars must have position relative and zindex > -1000 */
    return (
      <div style={{zIndex: -1000}}>
        <canvas
          style={{
            position: "absolute",
            top: this.props.top || 0,
            left: 0,
          }}
          width={this.props.width}
          height={this.props.height}>
        </canvas>
        {
          particles({
            color: this.props.color,
            count: this.props.count,
            radius: this.props.radius || 1.5,
            lineWidth: 1
          })
        }
      </div>
    );
  }
}

export default BackgroundStars;
