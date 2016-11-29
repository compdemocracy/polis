// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
