// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";



@Radium
class HexLogoTinyShort extends React.Component {
  styles() {
    return {
      link: {
        textDecoration: "none",
        cursor: "pointer",
      }
    }
  };
  render() {
    return (
        <a style={this.styles().link} href="http://pol.is">
          <svg width="41px" height="47px" viewBox="0 0 41 47">
            <g id="Page-1" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
              <g id="Artboard-7-Copy-8">
                <g id="Group">
                  <polygon id="Polygon-1" fill="#FFFFFF" points="20.4588192 0 40.9176384 11.75 40.9176384 35.25 20.4588192 47 1.67315897e-14 35.25 3.55271368e-15 11.75"></polygon>
                  <path d="M5.85714286,13.9834711 L7.41904762,17.8677686" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                  <text id="p." fontFamily="Georgia" fontSize="27.821225" fontWeight="normal" fill="#03A9F4">
                      <tspan x="12.1047619" y="28.3305785">p.</tspan>
                  </text>
                  <path d="M32.9952381,25.053719 L37.2904762,18.4504132" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                  <path d="M28.3095238,37.8719008 L32.4095238,34.9586777" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                  <path d="M20.3047619,41.5619835 L23.8190476,34.9586777" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                  <path d="M3.9047619,30.2975207 L7.41904762,18.6446281" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                  <path d="M28.3095238,37.8719008 L32.4095238,34.9586777" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="37.2904762" cy="18.4504132" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="29.4809524" cy="14.5661157" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="5.66190476" cy="13.7892562" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="7.61428571" cy="18.0619835" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="3.70952381" cy="30.4917355" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="24.0142857" cy="34.7644628" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="23.2333333" cy="10.6818182" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="14.6428571" cy="11.0702479" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="16.2047619" cy="8.35123967" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="20.1095238" cy="6.79752066" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="20.1095238" cy="41.7561983" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="28.3095238" cy="37.8719008" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="28.3095238" cy="33.9876033" rx="0.585714286" ry="0.582644628"></ellipse>
                  <ellipse id="Oval-17" fill="#03A9F4" cx="32.2142857" cy="35.1528926" rx="0.585714286" ry="0.582644628"></ellipse>
                  <path d="M16.2047619,8.35123967 L23.0380952,10.4876033" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                  <path d="M14.8380952,10.8760331 L16.0095238,8.54545455" id="Line" stroke="#03A9F4" strokeWidth="0.3" strokeLinecap="square"></path>
                </g>
              </g>
            </g>
          </svg>
        </a>
    );
  }
}

export default HexLogoTinyShort;
