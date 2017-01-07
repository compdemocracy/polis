import React from "react";
import Radium from "radium";
// import _ from "lodash";
import * as globals from "./globals";

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
      <p style={{fontSize: globals.primaryHeading}}>Overview</p>

        <p style={{width: globals.paragraphWidth}}>
          This conversation was run by {this.props.owner}. It was presented {this.props.medium}
          to an audience of {this.props.audiences}. The conversation was run for {this.props.duration}.
          The participants were prompted to give their perspective on {this.props.topic}.
          The specific question was {this.props.description}.

          A total of {this.props.partipcants} participated. {this.props.demographics} were women
        </p>
      </div>
    );
  }
}

export default Overview;
