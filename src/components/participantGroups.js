import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Group from "./participantGroup";

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
    console.log(this.props)
    const styles = this.getStyles();
    return (
      <div style={[
        styles.base,
        this.props.style
      ]}>
      {
        this.props.math && this.props.comments ? _.map(this.props.math["repness"], (groupComments, i) => {
          return (
            <Group
              key={i}
              allComments={this.props.comments}
              repnessIndex={i}
              conversation={this.props.conversation}
              groupComments={groupComments}
              math={this.props.math}/>
          );
        }) : "Loading Groups"
      }
      </div>
    );
  }
}

export default ParticipantGroups;
