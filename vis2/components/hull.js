import React from "react";
import * as globals from "./globals";

class Hull extends React.Component {
  render () {
    const line = d3.line().curve(d3.curveCatmullRom);
    const pathString = line(this.props.hull.hull);
    return (
      <g>
        <path
          d={pathString}
          ref={this.props.getHullElems(this.props.gid)}
          fill={/*globals.groupColor(hull.group[0].gid)*/ "rgb(220,220,220)"}
          fillOpacity={.6}/>
      </g>
    );
  }
};

class Hulls extends React.Component {
  render () {
    return (
      <g>
        {
          this.props.hulls ? this.props.hulls.map((hull) => {
            let gid = hull.group[0].gid;
            return <Hull
              key={gid}
              gid={gid}
              getHullElems={this.props.getHullElems}
              hull={hull}/>
          }) : ""
        }
      </g>
    )
  }
}

export default Hulls;
