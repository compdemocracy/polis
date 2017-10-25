import React from "react";
import * as globals from "../globals";

const Legend = () => {
  return (
    <svg style={{width: 400, height: 20, border: "1px solid lightgrey"}}>
      <rect width={70} height={20} fill={globals.brandColors.agree} x={0}></rect>
      <rect width={170} height={20} fill={globals.brandColors.disagree} x={70}></rect>
      <rect width={70} height={20} fill={globals.brandColors.pass} x={240}></rect>
      <text y={14} x={8} fill="white" style={{fontSize: 12}}>% Agreed</text>
      <text y={14} x={115} fill="white" style={{fontSize: 12}}>% Disagreed</text>
      <text y={14} x={247} fill="black" style={{fontSize: 12}}>% Passed</text>
      <text y={14} x={318} fill="black" style={{fontSize: 12}}>% Didn't vote</text>
    </svg>
  )
}

export default Legend;
