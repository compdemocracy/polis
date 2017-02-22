import React from "react";
import _ from "lodash";
import {ReactSVGPanZoom} from 'react-svg-pan-zoom';
import * as globals from "./globals";
import graphUtil from "../util/graphUtil";

import Axes from "./graphAxes";
import Comments from "./graphComments";
import Participants from "./graphParticipants";
import Hull from "./hull";

class Graph extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      selectedComment: null,
    };
  }

  handleCommentHover(selectedComment) {
    return () => {
      // console.log('setting state', selectedComment)
      this.setState({selectedComment});
    }
  }

  render() {

    if (!this.props.math) {
      return null;
    }

    const {
      xx,
      yy,
      commentsPoints,
      xCenter,
      yCenter,
      baseClustersScaled,
      commentScaleupFactorX,
      commentScaleupFactorY,
      hulls,
    } = graphUtil(this.props.comments, this.props.math, this.props.badTids);

    return (
      <div>
        <p style={{fontSize: globals.primaryHeading}}> Opinion Graph </p>
        <p style={globals.paragraph}>
          This graph shows all people and all comments.
        </p>
        <p style={globals.paragraph}>
          Comments, identified by their number, are positioned more closely to comments that were voted on similarly (blue, in the correlation matrix above). Comments are positioned further away from comments that tended to be voted on differently (red, in the correlation matrix above). </p>
        <p style={globals.paragraph}>People are positioned closer to the comments on which they agreed, and further from the comments on which they disagreed. Groups of participants that tended to vote similarly across many comments (elaborated in the previous section) are identified by their similar color.
        </p>
        <svg width={globals.side} height={globals.side} style={{marginTop: 30}}>
          <Axes selectedComment={this.state.selectedComment} xCenter={xCenter} yCenter={yCenter}/>

          <Participants points={baseClustersScaled}/>
          {/* this.props.math["group-clusters"].map((cluster, i) => {
            return (<text x={300} y={300}> Renzi Supporters </text>)
          }) : null */}
          {
            commentsPoints ?
            <Comments
              handleCommentHover={this.handleCommentHover.bind(this)}
              points={commentsPoints}
              repfulAgreeTidsByGroup={this.props.repfulAgreeTidsByGroup}
              xx={xx}
              yy={yy}
              xCenter={xCenter}
              yCenter={yCenter}
              xScaleup={commentScaleupFactorX}
              yScaleup={commentScaleupFactorY}
              formatTid={this.props.formatTid}/> :
            null
          }
          {
            hulls.map((hull) => {
              return <Hull key={hull.group[0].gid} hull={hull}/>
            })
          }
        </svg>
      </div>
    );
  }
}

export default Graph;


// {/*this.props.math["group-clusters"].map((c, i) => {
//   return (<text
//   key={i}
//   transform={globals.getGroupNamePosition(i)}
//   fill="rgba(0,0,0,0.7)"
//   style={{
//   display: "block",
//   fontFamily: "Helvetica, sans-serif",
//   fontSize: 10,
//   fontWeight: 700
//   }}
//   >
//   {this.props.groupNames[c.id]}
//   </text>);
//   }) */}
