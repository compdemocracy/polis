import React from "react";
import Radium from "radium";
// import _ from "lodash";
import * as globals from "./globals";

@Radium
class Heading extends React.Component {
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
      <p style={{fontSize: globals.primaryHeading}}> pol.is report </p>

      </div>
    );
  }
}

export default Heading;
