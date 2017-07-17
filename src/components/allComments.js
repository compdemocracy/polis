import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Comment from "./comment";
import * as globals from "./globals";
import style from "../util/style";

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
    if (!this.props.conversation) {
      return <div>Loading All Comments...</div>
    }
    const styles = this.getStyles();
    const comments = _.keyBy(this.props.comments, "tid");

    return (
      <div style={[
        styles.base,
        this.props.style
      ]}>
      <p style={globals.primaryHeading}> All Comments </p>
      <p style={globals.paragraph}>
        This is a list of the {this.props.comments.length} comments that were accepted into the conversation by moderators.
      </p>
      <div style={{marginTop: 50}}>
      {
        this.props.comments ? this.props.comments.map((c, i) => {
          return <Comment
            conversation={this.props.conversation}
            key={i}
            index={i}
            comment={comments[c.tid]}
            formatTid={this.props.formatTid}
            ptptCount={this.props.ptptCount}/>
        })
        : "Loading All Comments"
      }
      </div>
      </div>
    );
  }
}

export default AllComments;
