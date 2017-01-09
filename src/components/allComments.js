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
      <p style={{fontSize: globals.primaryHeading}}> All Comments </p>
      <p style={{width: globals.paragraphWidth}}>
        This is a list of the {this.props.comments.length} comments that were accepted into the conversation by moderators and were voted on by greater than [n%] of the <span style={style.variable}>{this.props.ptptCount}</span> participants.
      </p>
      {
        this.props.comments ? this.props.comments.map((c, i) => {
          return <Comment
            conversation={this.props.conversation}
            key={i}
            index={i}
            comment={comments[c.tid]}
            ptptCount={this.props.ptptCount}/>
        })
        : "Loading All Comments"
      }

      </div>
    );
  }
}

export default AllComments;
