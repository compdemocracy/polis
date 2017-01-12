import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Group from "./participantGroup";
import style from "../util/style";
import * as globals from "./globals";

@Radium
class ParticipantGroups extends React.Component {
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
    if (!this.props.conversation) {
      return <div>Loading Groups</div>;
    }
    return (
      <div style={[
        styles.base,
        this.props.style
      ]}>
      <p style={{fontSize: globals.primaryHeading}}> Opinion Groups </p>
      <p style={globals.paragraph}>
        Across {this.props.ptptCount} total participants, {this.props.math["group-votes"].length} opinion groups emerged. There are two factors that define an opinion group. First, each opinion group is made up of a number of participants who tended to vote similarly on multiple comments. Second, each group of participants who voted similarly will have also voted distinctly differently from other groups.
      </p>
      <div style={{marginTop: 50}}>
      {
        this.props.math && this.props.comments ? _.map(this.props.math["repness"], (groupComments, i) => {
          return (
            <Group
              key={i}
              allComments={this.props.comments}
              repnessIndex={i}
              conversation={this.props.conversation}
              demographicsForGroup={this.props.demographics[i]}
              groupComments={groupComments}
              groupName={this.props.groupNames[i]}
              groupVotesForThisGroup={this.props.math["group-votes"][i]}
              ptptCount={this.props.ptptCount}/>
          );
        }) : "Loading Groups"
      }
      </div>
      </div>
    );
  }
}

export default ParticipantGroups;
