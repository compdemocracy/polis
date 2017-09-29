import React from "react";
import drawBeeswarm from "./drawBeeswarm";
import * as globals from "../globals";
import _ from "lodash";

class Beeswarm extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      beeswarmComment: null
    };
  }
  prepData() {
    console.log("beeswarm", this.props)
  }
  handleHover(d) {
    this.setState({beeswarmComment: d.data})
  }
  componentDidMount() {
    const commentsWithExtremity = [];
    _.each(this.props.comments, (comment) => {
      if (this.props.extremity[comment.tid] > 0) {
        const cwe = Object.assign({}, comment, {extremity: this.props.extremity[comment.tid]});
        commentsWithExtremity.push(cwe)
      }
    })

    drawBeeswarm(commentsWithExtremity, this.handleHover.bind(this));
  }
  render() {
    return (
      <div>
        <p style={globals.primaryHeading}> Which statements were divisive? </p>
        <p style={globals.paragraph}>
          Which statements did everyone vote the same way on, vs which statements were voted on differently?
          If most of the statements (here as little circles) are to the left of the graph, the conversation was mostly
          in agreement. If towards the right, there were a lot of controversial statements.
        </p>
        <p style={globals.paragraph}>
          If most of the statements (here as little circles) are to the left of the graph, the conversation was mostly
          in agreement. If towards the right, there were a lot of controversial statements.
        </p>
        <p style={{fontWeight: 500, maxWidth: 600, lineHeight: 1.4, minHeight: 70}}>
          {
            this.state.beeswarmComment ?
            "#" + this.state.beeswarmComment.tid + ". " + this.state.beeswarmComment.txt :
            "Hover on a comment to see it."
          }
        </p>

        <svg id="beeswarmAttachPointD3" width="960" height="200"></svg>
      </div>
    );
  }
}

export default Beeswarm;
