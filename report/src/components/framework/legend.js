// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import * as globals from "../globals";

const Legend = ({voteColors}) => {
  return (
    <svg style={{width: 400, height: 20, border: "1px solid lightgrey"}}>
      <rect width={70} height={20} fill={voteColors.agree} x={0}></rect>
      <rect width={170} height={20} fill={voteColors.disagree} x={70}></rect>
      <rect width={70} height={20} fill={voteColors.pass} x={240}></rect>
      <text y={14} x={8} fill="white" style={{fontSize: 12}}>% Agreed</text>
      <text y={14} x={115} fill="white" style={{fontSize: 12}}>% Disagreed</text>
      <text y={14} x={247} fill="black" style={{fontSize: 12}}>% Passed</text>
      <text y={14} x={318} fill="black" style={{fontSize: 12}}>% Didn't vote</text>
    </svg>
  )
}

export default Legend;
