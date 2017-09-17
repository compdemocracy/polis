
import React from "react";
import Radium from "radium";

/**

  flex-direction: row | row-reverse | column | column-reverse;
  flex-wrap: nowrap | wrap | wrap-reverse;
  justify-content: flex-start | flex-end | center | space-between | space-around;
  align-items: flex-start | flex-end | center | baseline | stretch;
  align-content: flex-start | flex-end | center | space-between | space-around | stretch;
  flex is growShrinkBasis

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
    grow: React.PropTypes.number,
    shrink: React.PropTypes.number,
    basis: React.PropTypes.string,
    order: React.PropTypes.number,
    alignSelf: React.PropTypes.oneOf([
      "auto", "flex-start", "flex-end", "center", "baseline", "stretch"
    ]),
    styleOverrides: React.PropTypes.object,
    children: React.PropTypes.node,
    clickHandler: React.PropTypes.func,
  }
  static defaultProps = {
    direction: "row",
    wrap: "nowrap",
    justifyContent: "center",
    alignItems: "center",
    alignContent: "stretch",
    grow: 0,
    shrink: 1,
    basis: "auto",
    alignSelf: "auto",
    order: 0,
    styleOverrides: {}
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
        order: this.props.order,
        flexGrow: this.props.grow,
        flexShrink: this.props.shrink,
        flexBasis: this.props.basis,
        alignSelf: this.props.alignSelf,
      },
      styleOverrides: this.props.styleOverrides
    }
  }

  render() {
    const styles = this.getStyles();

    return (
      <div
        onClick={this.props.clickHandler}
        style={[
          styles.base,
          styles.styleOverrides
        ]}>
        {this.props.children}
      </div>
    );
  }
}

export default Radium(Flex);
