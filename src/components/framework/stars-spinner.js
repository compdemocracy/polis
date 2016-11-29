// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
// import _ from "lodash";
import {particles} from "./connected-particles";
import Flex from "./flex";

@Radium
class StarsSpinner extends React.Component {
  static propTypes = {
    /* component api */
    // foo: React.PropTypes.string
    color: React.PropTypes.string,
    count: React.PropTypes.number,
    width: React.PropTypes.number,
    height: React.PropTypes.number,
    radius: React.PropTypes.number,
    lineWidth: React.PropTypes.number,
    style: React.PropTypes.object
  }
  static defaultProps = {
    nodeColor: "rgba(255,255,255,1)",
    count: Math.floor(window.innerWidth / 20),
    width: window.innerWidth,
    height: window.innerHeight,
    radius: 1.5,
    lineWidth: 1,
    text: "Loading...",
    style: {}
  }
  getStyles() {
    return {
      container: {
        // zIndex: -1000,
        position: "relative",
      },
      loading: {
        position: "relative",
        width: "100%",
        top: "100",
        textAlign: "center"
      }
    };
  }
  render() {
    const styles = this.getStyles();
    /* any content above the stars must have position relative and zindex > -1000 */
    return (
      <div
        ref="container"
        style={[
          styles.container,
          this.props.style.container
        ]}>
        <p style={[styles.loading, this.props.style.loading]}>
          {this.props.text}
        </p>
        <canvas
          width={this.props.width}
          height={this.props.height}>
        </canvas>
        {
          particles({
            color: this.props.nodeColor,
            count: this.props.count,
            radius: this.props.radius,
            lineWidth: this.props.lineWidth
          })
        }
      </div>
    );
  }
}

export default StarsSpinner;
//
// <canvas
//   width={this.props.width}
//   height={this.props.height}>
