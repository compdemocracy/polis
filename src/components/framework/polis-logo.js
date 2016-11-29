// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";



@Radium
class PolisLogo extends React.Component {
  styles() {
    return {
      link: {
        textDecoration: "none",
        cursor: "pointer",
        color: this.props.color ? this.props.color : "white",
        fontSize: 24,
        margin: "15px 0px"
      }
    }
  };
  render() {
    return (
      <Flex
        styleOverrides={this.props.containerStyle}
        align="center" >
        <div style={{
          width: 12,
          height: 12,
          marginRight: 6,
          position: "relative", top: 3,
          borderRadius: 20,
          backgroundColor: this.props.backgroundColor ? this.props.backgroundColor : "rgb(255,255,255)"}}>
        </div>
        <div style={{
          width: 16,
          height: 16,
          marginRight: 6,
          position: "relative", top: 3,
          borderRadius: 20,
          backgroundColor: this.props.backgroundColor ? this.props.backgroundColor : "rgb(255,255,255)"}}>
        </div>
        <div style={{
          width: 8,
          height: 8,
          marginRight: 6,
          position: "relative", top: 3,
          borderRadius: 20,
          backgroundColor: this.props.backgroundColor ? this.props.backgroundColor : "rgb(255,255,255)"}}>
        </div>
        <a style={this.styles().link} href="http://pol.is">
            pol.is
        </a>
      </Flex>
    );
  }
}

export default PolisLogo;
