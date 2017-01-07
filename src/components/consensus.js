import React from "react";
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";
import * as globals from "./globals";


@Radium
class Consensus extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  getStyles() {
    return {
      base: {

      }
    };
  }

  render() {
    const styles = this.getStyles();
    const comments = _.keyBy(this.props.comments, "tid");
    return (
      <div style={[
        styles.base,
        this.props.style
      ]}>
      <p style={{fontSize: globals.primaryHeading}}> Consensus </p>
        {
          this.props.consensus ? this.props.consensus.agree.map((c, i) => {
            return <Comment
              conversation={this.props.conversation}
              key={i}
              index={i}
              comment={comments[c.tid]}/>
          })
          : "Loading Consensus"
        }
        {
          this.props.consensus ? this.props.consensus.disagree.map((c, i) => {
            return <Comment
              conversation={this.props.conversation}
              key={i}
              index={i}
              comment={comments[c.tid]}/>
          })
          : "Loading Consensus"
        }
      </div>
    );
  }
}

export default Consensus;
