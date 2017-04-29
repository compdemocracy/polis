import React from "react";
import * as globals from "./globals";
import Comments from "./graphComments";
import Participants from "./graphParticipants";

class Force extends React.Component {

  constructor(props) {
    super(props);

    this.commentsPointsCopy = null;

    this.state = {
      force_active: false,
    };
  }

  componentDidUpdate() {
    /* do force once for now - we'll need to NOT shouldComponentUpdate if it was just a hover on a comment... or be positive and say we just got new math as a flag */
    if (!this.state.force_active) {
      this.doForce()
    }
  }

  onForceTick(data) {
    console.log("d3 force tick", data)
    this.setState({force_active: true});
  }

  doForce () {

    /*
      make a copy of comments, force will mutate it in place and call tick when it has.
      it would be nice if tick was passed data, but that is not the universe among universes we live in.
    */
    this.commentsPointsCopy = this.props.commentsPoints.slice(0)

    const collisionForce = d3.forceCollide()
                              .radius((d) => { return 5; })
                              .strength(1)
                              .iterations(100);
    const simulation = d3.forceSimulation(this.commentsPointsCopy)
                          .alphaDecay(0.01)
                          .force("collisionForce", collisionForce)
                          .on("tick", this.onForceTick.bind(this))
                          .on("end", () => {
                            this.setState({
                              force_active: false,
                              force_counter: this.state.force_counter + 1,
                            })
                          })
  }

  render () {
    if (this.commentsPointsCopy) {
      console.log('0',this.commentsPointsCopy[0])
    }
    
    return (
      <g>
        <Participants
          points={this.props.baseClustersScaled}
          ptptois={this.props.ptptois}
          ptptoiScaleFactor={this.props.ptptoiScaleFactor}/>
        <Comments
          commentsPoints={this.commentsPointsCopy /* this is a copy stored on the class, see comment above */}
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
