import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Group from "./participantGroup";
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
      <p style={{width: globals.paragraphWidth}}>
        Across {this.props.conversation.participant_count} total participants, {this.props.math["group-votes"].length} opinion groups emerged. Each opinion group is made up of a number of participants who tended to vote similarly, and differently from other opinion groups, on multiple comments.
      </p>
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
              groupVotesForThisGroup={this.props.math["group-votes"][i]}/>
          );
        }) : "Loading Groups"
      }
      </div>
    );
  }
}

export default ParticipantGroups;
