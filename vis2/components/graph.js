import React from "react";
import _ from "lodash";
// import {ReactSVGPanZoom} from 'react-svg-pan-zoom';
import * as globals from "./globals";
import graphUtil from "../util/graphUtil";

import Axes from "./graphAxes";
import Comments from "./graphComments";
import Participants from "./graphParticipants";
import Hulls from "./hull";
import BarChartsForGroupVotes from "./barChartsForGroupVotes";
import ExploreTid from "./exploreTid";
import TidCarousel from "./tidCarousel";
import Vote from "./voteView";

let ptptoiScaleFactor = 0.5;

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
    document.getElementsByClassName("groupSelectionView")[0].style.display = "none";
  }

  handleCommentHover(selectedComment) {
    return () => {
      document.getElementById("readReactView").style.display = "none";
      this.setState({selectedComment});
    }
  }

  handleCommentClick(selectedComment) {
    return () => {
      document.getElementById("readReactView").style.display = "none";
      this.setState({selectedComment});
    }
  }

  handleReturnToVoteClicked() {
    document.getElementById("readReactView").style.display = "block";
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

    if (!this.props.math) {
      return null;
    }

    let tidsToShowSet = _.keyBy(this.props.tidsToShow);

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
      groupCornerAssignments,
    } = graphUtil(this.props.comments, this.props.math, this.props.badTids);

    let should_only_show_voted_on_comments = false;

    commentsPoints = commentsPoints.filter((c) => {
      return !should_only_show_voted_on_comments || !_.isUndefined(tidsToShowSet[c.tid]);
    });
    let tidCarouselComments = this.props.comments.filter((c) => {
      return !should_only_show_voted_on_comments || !_.isUndefined(tidsToShowSet[c.tid]);
    });

    let heading = (<span><p style={{fontSize: globals.primaryHeading}}> Opinion Graph </p>
      <p style={globals.paragraph}>
        This graph shows all people and all comments.
      </p>
      <p style={globals.paragraph}>
        Comments, identified by their number, are positioned more closely to comments that were voted on similarly (blue, in the correlation matrix above). Comments are positioned further away from comments that tended to be voted on differently (red, in the correlation matrix above). </p>
      <p style={globals.paragraph}>People are positioned closer to the comments on which they agreed, and further from the comments on which they disagreed. Groups of participants that tended to vote similarly across many comments (elaborated in the previous section) are identified by their similar color.
      </p></span>);

    return (
      <div>
        {this.props.renderHeading ? heading : ""}
        {
          this.state.selectedComment ?
          <ExploreTid
            handleReturnToVoteClicked={this.handleReturnToVoteClicked.bind(this)}
            selectedComment={this.state.selectedComment}
            votesByMe={this.props.votesByMe}
            onVoteClicked={this.props.onVoteClicked}
            comments={this.props.comment}/> :
          <Vote
            />
        }
        <TidCarousel
          commentsToShow={tidCarouselComments}
          handleCommentClick={this.handleCommentClick.bind(this)}
          />
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
          <Hulls
            getHullElems={this.getHullElems.bind(this)}
            hulls={hulls} />
          <Participants points={baseClustersScaled} ptptois={this.props.ptptois} ptptoiScaleFactor={ptptoiScaleFactor}/>
          <Comments
            commentsPoints={commentsPoints}
            selectedComment={this.state.selectedComment}
            handleCommentHover={this.handleCommentHover.bind(this)}
            points={commentsPoints}
            repfulAgreeTidsByGroup={this.props.repfulAgreeTidsByGroup}
            repfulDisageeTidsByGroup={this.props.repfulDisageeTidsByGroup}
            xx={xx}
            yy={yy}
            xCenter={xCenter}
            yCenter={yCenter}
            xScaleup={commentScaleupFactorX}
            yScaleup={commentScaleupFactorY}
            formatTid={this.props.formatTid}/>
          <BarChartsForGroupVotes
            hullElems={this.hullElems}
            selectedComment={this.state.selectedComment}
            allComments={this.props.comments}
            groups={window.preload.firstMath["group-votes"]}
            groupCornerAssignments={groupCornerAssignments}
            />
        </svg>
      </div>
    );
  }
}

export default Graph;

          // <defs>
          //   <marker
          //     className={'helpArrow'}
          //     id={'ArrowTip'}
          //     viewBox={'0 0 14 14'}
          //     refX={'1'
          //     refY={'5'}
          //     markerWidth={'5'}
          //     markerHeight={'5'}
          //     orient={'auto'}>
          //     // "<path d='M 0 0 L 10 5 L 0 10 z' />
          //     <circle cx = {'6'} cy = {'6'} r = {'5'} />
          //   </marker>
          //   <clipPath id={"clipCircleVis2"}>
          //     <circle r={ptptOiRadius * ptptoiScaleFactor} cx={0} cy={0}/>
          //   </clipPath>
          //   <filter id={'colorMeMatrix'}>
          //     <feColorMatrix
          //       in={'SourceGraphic'}
          //       type={'matrix'}
          //       values={'0.33 0.33 0.33 0 0
          //       0.33 0.33 0.33 0 0
          //       0.33 0.33 0.33 0 0
          //       0 0 0 1 0'} />
          //   </filter>

          //   <filter id={'colorMeMatrixRed'}
          //     <feColorMatrix
          //       in={'SourceGraphic'}
          //       type={'matrix'}
          //       values={'1.00 0.60 0.60 0 0.3
          //         0.10 0.20 0.10 0 0
          //         0.10 0.10 0.20 0 0
          //         0 0 0 1 0'} />
          //   </filter>

          //   <filter id={'colorMeMatrixGreen'}>
          //     <feColorMatrix
          //       in={'SourceGraphic'}
          //       type={'matrix'}
          //       values={'0.20 0.10 0.10 0 0
          //         0.60 1.00 0.60 0 0.3
          //         0.10 0.10 0.40 0 0
          //         0 0 0 1 0'} />
          //   </filter>
          // </defs>




// {/* this.props.math["group-clusters"].map((cluster, i) => {
//   return (<text x={300} y={300}> Renzi Supporters </text>)
// }) : null */}

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
