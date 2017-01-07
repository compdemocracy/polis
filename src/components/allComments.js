import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Comment from "./comment";

@Radium
class AllComments extends React.Component {
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
      <p> All Comments </p>
      </div>
    );
  }
}

export default AllComments;

// {
//   this.props.comments ? this.props.comments.map((c, i) => {
//     return <Comment
//       conversation={this.props.conversation}
//       key={i}
//       index={i}
//       comment={comments[c.tid]}/>
//   })
//   : "Loading All Comments"
// }
