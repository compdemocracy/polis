import React from "react";
import Radium from "radium";

/**

  flex-direction: row | row-reverse | column | column-reverse;
  flex-wrap: nowrap | wrap | wrap-reverse;
  justify-content: flex-start | flex-end | center | space-between | space-around;
  align-items: flex-start | flex-end | center | baseline | stretch;
  align-content: flex-start | flex-end | center | space-between | space-around | stretch;

**/

class Flex extends React.Component {
  static propTypes = {
    direction: React.PropTypes.oneOf([
      "row", "rowReverse", "column", "columnReverse"
    ]),
    wrap: React.PropTypes.oneOf([
      "nowrap", "wrap", "wrap-reverse"
    ]),
    justifyContent: React.PropTypes.oneOf([
      "flex-start", "flex-end", "center", "space-between", "space-around"
    ]),
    alignItems: React.PropTypes.oneOf([
      "flex-start", "flex-end", "center", "baseline", "stretch"
    ]),
    alignContent: React.PropTypes.oneOf([
      "flex-start", "flex-end", "center", "space-between", "space-around", "stretch"
    ]),
    styleOverrides: React.PropTypes.object,
    children: React.PropTypes.node,
  }
  static defaultProps = {
    direction: "row",
    wrap: "nowrap",
    justifyContent: "center",
    alignItems: "center",
    alignContent: "stretch",
    styleOverrides: null
  }
  getStyles() {
    return {
      base: {
        display: "flex",
        flexDirection: this.props.direction,
        flexWrap: this.props.wrap,
        justifyContent: this.props.justifyContent,
        alignItems: this.props.alignItems,
        alignContent: this.props.alignContent,
      },
      styleOverrides: this.props.styleOverrides
    }
  }

  render() {
    const styles = this.getStyles();

    return (
      <div
        style={[
          styles.base,
          this.props.styleOverrides && styles.styleOverrides
        ]}>
        {this.props.children}
      </div>
    );
  }
}

export default Radium(Flex);