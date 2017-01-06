import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Comment from "./comment";

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
    return (
      <div style={[
        styles.base,
        this.props.style
      ]}>
      <p> Consensus </p>
        {
          this.props.consensus ? this.props.consensus.agree.map((c, i) => {
            return <Comment conversation={this.props.conversation} key={i} index={i} comment={this.props.comments[c.tid]}/>
          })
          : "Loading Consensus"
        }

      </div>
    );
  }
}

export default Consensus;
// 
// {
//   this.props.consensus ? this.props.consensus.disagree.map((c, i) => {
//     return <Comment conversation={this.props.conversation} key={i} index={i} comment={this.props.comments[c.tid]}/>
//   })
//   : "Loading Consensus"
// }
