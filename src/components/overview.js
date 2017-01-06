import React from "react";
import Radium from "radium";
// import _ from "lodash";

@Radium
class Overview extends React.Component {
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
        <p>
          This conversation was run by {this.props.owner}. It was presented {this.props.medium}
          to an audience of {this.props.audiences}. The conversation was run for {this.props.duration}.
          The participants were prompted to give their perspective on {this.props.topic}.
          The specific question was {this.props.description}.
        </p>
      </div>
    );
  }
}

export default Overview;
