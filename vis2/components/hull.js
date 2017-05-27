import React from "react";
import * as globals from "./globals";
import {VictoryAnimation} from "victory";

class Hull extends React.Component {
  render () {
    return (
      <g>
        <path
          onClick={() => {this.props.handleClick(this.props.gid)}}
          d={this.props.pathString}
          ref={this.props.getHullElems(this.props.gid)}
          fill={/*globals.groupColor(hull.group[0].gid)*/ "rgb(220,220,220)"}
          fillOpacity={.6}/>
      </g>
    );
  }
};

class Hulls extends React.Component {
  render () {
    const line = d3.line(); // .curve(d3.curveBasis);
    return (
      <g>
        {
          this.props.hulls ? this.props.hulls.map((hull) => {
            let gid = hull.group[0].gid;
            const pathString = line(hull.hull);
            return (
              <VictoryAnimation
                easing={"quadOut"}
                duration={1500}
                key={gid}
                data={{tweenPath: pathString}}>
                {(tweenedProps, animationInfo) => {
                  // if (animationInfo.animating && animationInfo.progress < 1) {
                  return <Hull
                    key={gid}
                    gid={gid}
                    pathString={tweenedProps.tweenPath}
                    getHullElems={this.props.getHullElems}
                    handleClick={this.props.handleClick}
                    hull={hull}/>
                  // }
                }}
              </VictoryAnimation>
            )
          }) : ""
        }
      </g>
    )
  }
}

export default Hulls;
