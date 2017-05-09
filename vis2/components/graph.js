import React from "react";
import _ from "lodash";
// import {ReactSVGPanZoom} from 'react-svg-pan-zoom';
import * as globals from "./globals";
import graphUtil from "../util/graphUtil";
import Axes from "./graphAxes";
import Hulls from "./hull";
import BarChartsForGroupVotes from "./barChartsForGroupVotes";
import ExploreTid from "./exploreTid";
import TidCarousel from "./tidCarousel";
import Participants from "./graphParticipants";
import Comments from "./graphComments";
import Curate from "./curate";
import HullLabels from "./hullLabels";

class Graph extends React.Component {

  constructor(props) {
    super(props);
    this.hullElems = [];
    this.Viewer = null;

    this.state = {
      selectedComment: null,
    };
  }

  componentWillMount() {
    document.getElementById("helpTextGroups").style.display = "none";
    document.getElementById("visualization_div").style.display = "none";
    document.getElementById("carouselPane").style.display = "none";
    document.getElementById("groupSelectionViewContainer").style.display = "none";
  }

  componentWillReceiveProps(nextProps) {

    if (!nextProps.math) {
      return;
    }

    let tidsToShowSet = _.keyBy(nextProps.tidsToShow);

    let {
      xx,
      yy,
      commentsPoints,
      xCenter,
      yCenter,
      baseClustersScaled,
      commentScaleupFactorX,
      commentScaleupFactorY,
      hulls,
      groupCentroids,
      groupCornerAssignments,
    } = graphUtil(nextProps.comments, nextProps.math, nextProps.badTids);

    let should_only_show_voted_on_comments = false;
    let ptptoiScaleFactor = 0.5;

    commentsPoints = commentsPoints.filter((c) => {
      return !should_only_show_voted_on_comments || !_.isUndefined(tidsToShowSet[c.tid]);
    });

    let tidCarouselComments = nextProps.comments.filter((c) => {
      return !should_only_show_voted_on_comments || !_.isUndefined(tidsToShowSet[c.tid]);
    });

    this.setState({
      xx,
      yy,
      commentsPoints,
      xCenter,
      yCenter,
      baseClustersScaled,
      ptptoiScaleFactor,
      commentScaleupFactorX,
      commentScaleupFactorY,
      hulls,
      groupCentroids,
      groupCornerAssignments,
      commentsPoints,
      tidCarouselComments
    })

  }

  handleCommentHover(selectedComment) {
    return () => {
      // document.getElementById("readReactView").style.display = "none";
      this.setState({selectedComment});
    }
  }

  handleCommentClick(selectedComment) {
    return () => {
      // document.getElementById("readReactView").style.display = "none";
      this.setState({selectedComment});
    }
  }

  handleReturnToVoteClicked() {
    // document.getElementById("readReactView").style.display = "block";
    this.setState({selectedComment: null})
  }

  getHullElems(gid) {
    return (elem) => {
      if (elem !== null) {
        this.hullElems[gid] = elem;
      }
    }
  }

  render() {

    return (
      <div>
        <svg width={globals.side} height={globals.side}>

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
          <Axes
            xCenter={this.state.xCenter}
            yCenter={this.state.yCenter}
            report={this.props.report}/>
          <Hulls
            getHullElems={this.getHullElems.bind(this)}
            hulls={this.state.hulls} />
          <HullLabels
            groups={window.preload.firstMath["group-votes"] /* for labels */}
            centroids={this.state.groupCentroids}
            />
          <Participants
            points={this.state.baseClustersScaled}
            ptptois={this.props.ptptois}
            ptptoiScaleFactor={this.state.ptptoiScaleFactor}/>
          <Comments
            commentsPoints={this.state.commentsPoints}
            selectedComment={this.state.selectedComment}
            handleCommentHover={this.handleCommentHover.bind(this)}
            points={this.state.commentsPoints}
            repfulAgreeTidsByGroup={this.props.repfulAgreeTidsByGroup}
            repfulDisageeTidsByGroup={this.props.repfulDisageeTidsByGroup}
            formatTid={this.props.formatTid}/>
          <BarChartsForGroupVotes
            hullElems={this.hullElems}
            selectedComment={this.state.selectedComment}
            allComments={this.props.comments}
            groups={window.preload.firstMath["group-votes"]}
            groupCornerAssignments={this.state.groupCornerAssignments}
            />
        </svg>
        <Curate/>
        <TidCarousel
          commentsToShow={this.state.tidCarouselComments}
          handleCommentClick={this.handleCommentClick.bind(this)}
          selectedComment={this.state.selectedComment}
          />
        <ExploreTid
          handleReturnToVoteClicked={this.handleReturnToVoteClicked.bind(this)}
          selectedComment={this.state.selectedComment}
          votesByMe={this.props.votesByMe}
          onVoteClicked={this.props.onVoteClicked}
          comments={this.props.comment}/>
      </div>
    );
  }
}

export default Graph;


/* heading */

// let heading = (<span><p style={{fontSize: globals.primaryHeading}}> Opinion Graph </p>
//   <p style={globals.paragraph}>
//     This graph shows all people and all comments.
//   </p>
//   <p style={globals.paragraph}>
//     Comments, identified by their number, are positioned more closely to comments that were voted on similarly (blue, in the correlation matrix above). Comments are positioned further away from comments that tended to be voted on differently (red, in the correlation matrix above). </p>
//   <p style={globals.paragraph}>People are positioned closer to the comments on which they agreed, and further from the comments on which they disagreed. Groups of participants that tended to vote similarly across many comments (elaborated in the previous section) are identified by their similar color.
//   </p></span>);
//   {this.props.renderHeading ? heading : ""}

/* group labels */

// {/* this.props.math["group-clusters"].map((cluster, i) => {
//   return (<text x={300} y={300}> Renzi Supporters </text>)
// }) : null */}

/* React SVG Pan Zoom */

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
