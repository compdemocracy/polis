import React from "react";
import Radium from "radium";
// import _ from "lodash";

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
    return (
      <div style={[
        styles.base,
        this.props.style
      ]}>
        {"ParticipantGroups"}
      </div>
    );
  }
}

export default ParticipantGroups;
