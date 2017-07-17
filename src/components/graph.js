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
    this.Viewer = null;
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

    let heading = (<span><p style={globals.primaryHeading}> Opinion Graph </p>
      <p style={globals.paragraph}>
        This graph shows all people and all comments.
      </p>
      <p style={globals.paragraph}>
        Comments, identified by their number, are positioned more closely to comments that were voted on similarly (blue, in the correlation matrix above). Comments are positioned further away from comments that tended to be voted on differently (red, in the correlation matrix above). </p>
      <p style={globals.paragraph}>People are positioned closer to the comments on which they agreed, and further from the comments on which they disagreed. Groups of participants that tended to vote similarly across many comments (elaborated in the previous section) are identified by their similar color.
      </p></span>);

    return (
      <div style={{position: "relative"}}>
        {this.props.renderHeading ? heading : ""}

        <p style={Object.assign({}, globals.paragraph, {position: "absolute", left: 160})}>
          {this.state.selectedComment ? "#" + this.state.selectedComment.tid + ". " + this.state.selectedComment.txt : null}
        </p>
          <svg width="100%" height={globals.side}>
            {/* Comment https://bl.ocks.org/mbostock/7555321 */}
            <g transform={`translate(${globals.side / 2}, ${15})`}>
              <text
                style={{
                  fontFamily: "Georgia",
                  fontSize: 14,
                  fontStyle: "italic"
                }}
                textAnchor="middle">

              </text>
            </g>
            <Axes xCenter={xCenter} yCenter={yCenter} report={this.props.report}/>
            {/*<Participants points={baseClustersScaled}/>*/}
            {/* this.props.math["group-clusters"].map((cluster, i) => {
              return (<text x={300} y={300}> Renzi Supporters </text>)
            }) : null */}
            {
              hulls.map((hull) => {
                let gid = hull.group[0].gid;
                if (_.isNumber(this.props.showOnlyGroup)) {
                  if (gid !== this.props.showOnlyGroup) {
                    return "";
                  }
                }
                return <Hull key={gid} hull={hull}/>
              })
            }
            {
              commentsPoints ?
              <Comments
                handleCommentHover={this.handleCommentHover.bind(this)}
                points={commentsPoints}
                repfulAgreeTidsByGroup={this.props.repfulAgreeTidsByGroup}
                repfulDisageeTidsByGroup={this.props.repfulDisageeTidsByGroup}
                showOnlyGroup={this.props.showOnlyGroup}
                xx={xx}
                yy={yy}
                xCenter={xCenter}
                yCenter={yCenter}
                xScaleup={commentScaleupFactorX}
                yScaleup={commentScaleupFactorY}
                formatTid={this.props.formatTid}/> :
              null
            }
          </svg>

      </div>
    );
  }
}

export default Graph;

// componentDidMount() {
//   this.Viewer.fitToViewer();
// }
// <div>
//   <button onClick={event => this.Viewer.zoomOnViewerCenter(1.1)}>Zoom in</button>
//   <button onClick={event => this.Viewer.fitSelection(40, 40, 200, 200)}>Zoom area</button>
//   <button onClick={event => this.Viewer.fitToViewer()}>Fit</button>
// </div>

// <ReactSVGPanZoom
//   style={{outline: "1px solid black", fill: "white"}}
//   width={500} height={500} ref={Viewer => this.Viewer = Viewer}
//   onClick={event => console.log('click', event.x, event.y, event.originalEvent)}
//   onMouseMove={event => console.log('move', event.x, event.y)} >
//
// </ReactSVGPanZoom>
