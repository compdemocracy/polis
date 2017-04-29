import React from "react";
import * as globals from "./globals";
import { forceSimulation, forceCollide, forceManyBody } from "d3-force";
import Comments from "./graphComments";
import Participants from "./graphParticipants";

class Force extends React.Component {

  constructor(props) {
    super(props);
    this.hullElems = [];
    this.Viewer = null;

    this.state = {
      force_counter: 0,
      force_active: false,
    };
  }

  onForceTick() {
    this.setState({force_active: true})
  }

  doForce () {
    const attractForce = d3.forceManyBody()
                            .strength(580)
                            .distanceMax(400)
                            .distanceMin(1);

    const collisionForce = d3.forceCollide()
                              .radius((d) => { return d.r + 0.5; })
                              .strength(1)
                              .iterations(100);

    const simulation = d3.forceSimulation()
                          .alphaDecay(0.01)
                          .force("attractForce", attractForce)
                          .force("collisionForce", collisionForce)
                          .on("tick", this.onForceTick.bind(this))
                          .on("end", () => {
                            this.setState({
                              force_pause: true,
                              force_counter: this.state.force_counter + 1,
                            })
                          })
  }

  render () {
    return (
      <g>
        <Participants
          points={this.props.baseClustersScaled}
          ptptois={this.props.ptptois}
          ptptoiScaleFactor={this.props.ptptoiScaleFactor}/>
        <Comments
          commentsPoints={this.props.commentsPoints}
          selectedComment={this.props.selectedComment}
          handleCommentHover={this.props.handleCommentHover}
          points={this.props.commentsPoints}
          repfulAgreeTidsByGroup={this.props.repfulAgreeTidsByGroup}
          repfulDisageeTidsByGroup={this.props.repfulDisageeTidsByGroup}
          xx={this.props.xx}
          yy={this.props.yy}
          xCenter={this.props.xCenter}
          yCenter={this.props.yCenter}
          xScaleup={this.props.commentScaleupFactorX}
          yScaleup={this.props.commentScaleupFactorY}
          formatTid={this.props.formatTid}/>
      </g>
    )
  }

}

export default Force;
