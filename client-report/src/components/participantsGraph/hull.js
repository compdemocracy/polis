// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import * as globals from "../globals";

const Hull = ({hull}) => {
  const line = d3.line().curve(d3.curveLinear);
  const pathString = line(hull.hull);

  return (
    <path
      d={pathString}
      strokeDasharray="5, 5"
      stroke={"rgb(90,90,90)"}
      fill="none"
      fillOpacity={.4}/>
  );
};

export default Hull;

// fill={"rgba(0,0,0,.2)" /*globals.groupColor(hull.group[0].gid)*/}
