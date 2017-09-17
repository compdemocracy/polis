import React from "react";
import _ from "lodash";
import {ReactSVGPanZoom} from 'react-svg-pan-zoom';
import * as globals from "../globals";
import graphUtil from "../../util/graphUtil";
import Axes from "../graphAxes";
// import Participants from "./graphParticipants";
// import Hull from "./hull";
import textWrap from 'svg-text-wrap';

const TextSegment = ({t, i}) => <tspan x="27" y={i * 14}>{t}</tspan>

class Comments extends React.Component {

  createComments() {
    return this.props.points.map((comment, i) => {

      /* find the original comment */
      const _comment = _.find(this.props.comments, (c) => { return c.tid === comment.tid});

      /* see if it's meta or consensus */
      if (
        _comment.is_meta ||
        this.props.math.pca["comment-extremity"][comment.tid] < globals.maxCommentExtremityToShow
      ) {
        return
      }

      /* break the text up into pieces */
      const textArray = textWrap(comment.txt, 200, {'letter-spacing': '1px'})

      return <text
          key={i}
          transform={
            `translate(
              ${this.props.xCenter + comment.x * this.props.xScaleup},
              ${this.props.yCenter + comment.y * this.props.yScaleup}
            )`
          }
          onClick={this.props.handleClick(comment)}
          style={{
            fill: "rgba(0,0,0,.5)",
            fontFamily: "Helvetica",
            cursor: "pointer",
            fontSize: 10,
          }}
          >
          {this.props.formatTid(comment.tid)}
          {
            /*textArray.map((t, i) => {
              return (
                <TextSegment key={i} t={t} i={i}/>
              )
            })*/
          }
        </text>
    })
  }

  render () {
    return (
      <g>
        {this.createComments()}
      </g>
    );
  }
}

class Graph extends React.Component {

  constructor(props) {
    super(props);
    this.Viewer = null;
    this.state = {
      selectedComment: null,
    };
  }

  handleCommentClick(selectedComment) {
    return () => {
      console.log('setting state', selectedComment)
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
      <div style={{position: "relative"}}>
        <div>
          <p style={globals.primaryHeading}> A graph of disagreement </p>
          <p style={globals.paragraph}>
          How do comments relate to each other? Did people who agreed with one comment also agree with another?
          </p>
          <p style={globals.paragraph}>
          In this graph, comments that met disagreement are closer together if they were voted on similarly.
          Those comments which were voted on differently are further apart.
          </p>
          <p style={Object.assign({}, globals.paragraph, {fontStyle: "italic"})}>
          This is important because it is the basis on which we will lay out and cluster participants in a 2d space in later steps
          (closer to the comments on which they agreed). There are no meaningful axes, but there are regions of comments that lend a
          certain personality to a given area.
          </p>
        </div>
        <p style={{fontWeight: 500, maxWidth: 900}}>
          {
            this.state.selectedComment ?
            "#" + this.state.selectedComment.tid + ". " + this.state.selectedComment.txt :
            "Click a comment, identified by its number, to explore regions of the graph."
          }
        </p>
          <svg
            style={{
              border: "1px solid rgb(130,130,130)",
              backgroundColor: "rgb(245,245,245)"
            }}
            width={this.props.height ? this.props.height : globals.side}
            height={this.props.height ? this.props.height : globals.side}>
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
            // {/*<Participants points={baseClustersScaled}/>*/}
            {/* this.props.math["group-clusters"].map((cluster, i) => {
              return (<text x={300} y={300}> Renzi Supporters </text>)
            }) : null */}
            {/*
              hulls.map((hull) => {
                let gid = hull.group[0].gid;
                if (_.isNumber(this.props.showOnlyGroup)) {
                  if (gid !== this.props.showOnlyGroup) {
                    return "";
                  }
                }
                return <Hull key={gid} hull={hull}/>
              })
            */}
            {
              commentsPoints ?
              <Comments
                {...this.props}
                handleClick={this.handleCommentClick.bind(this)}
                points={commentsPoints}
                xx={xx}
                yy={yy}
                xCenter={xCenter}
                yCenter={yCenter}
                xScaleup={commentScaleupFactorX}
                yScaleup={commentScaleupFactorY}/> :
              null
            }
          </svg>

      </div>
    );
  }
}

export default Graph;
