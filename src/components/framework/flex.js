import React from "react";
import Radium from "radium";
import Item from "./flex-item";

/**
  The <Flex> component automatically wraps each of its children in a <FlexItem> component.

  Modifiers:
  ----------

  Vertical alignment:
  align="top"     - Top aligned
  align="center"  - Center aligned
  align="bottom"  - Bottom aligned
  align="baseline" - Text baseline aligned

  Justify Content:
  justifyContent="center"  - Each Flex.Item is aligned starting from the center
                             (other options: flex-start, flex-end, space-between, space-around)

  Gutters:
  gutters={1.2} - Padding (em) between Flex.Items

  Usage:
  ----------
  <Flex align="top" gutters={1}>
    <Flex.Item fit={true}> I’m a silly cell! </Flex.Item>
    <Flex.Item fit={true}> I’m a silly cell! </Flex.Item>
  </Flex>
**/

class Flex extends React.Component {
  getStyles() {
    return {
      base: {
        display: "flex",
        flexWrap: "wrap",
        listStyle: "none",
        justifyContent: this.props.justifyContent || "center",
        margin: 0,
        padding: 0
      },
      top: {
        alignItems: "flex-start"
      },
      center: {
        alignItems: "center"
      },
      bottom: {
        alignItems: "flex-end"
      },
      baseline: {
        alignItems: "baseline"
      },
      row: {
        flexDirection: "row"
      },
      rowReverse: {
        flexDirection: "row-reverse"
      },
      column: {
        flexDirection: "column"
      },
      columnReverse: {
        flexDirection: "column-reverse"
      },
      gutters: {
        margin: "-" + this.props.gutters + "em 0 0 -" + this.props.gutters + "em"
      },
      styleOverrides: this.props.styleOverrides
    };
  }

  buildChildren() {
    return React.Children.map(this.props.children, (child) => {
      return child ?
        React.cloneElement(child, { gutters: child.props.gutters || this.props.gutters }) :
        undefined;
    });
  }

  render() {
    const styles = this.getStyles();

    return (
      <div
        style={[
          styles.base,
          styles[this.props.align],
          styles[this.props.direction],
          this.props.gutters && styles.gutters,
          this.props.styleOverrides && styles.styleOverrides
        ]}>
        {this.buildChildren()}
      </div>
    );
  }
}

Flex.propTypes = {
  align: React.PropTypes.oneOf(["top", "center", "bottom", "baseline"]),
  direction: React.PropTypes.oneOf(["row", "rowReverse", "column", "columnReverse"]),
  children: React.PropTypes.node,
  gutters: React.PropTypes.number,
  justifyContent: React.PropTypes.oneOf([
    "flex-start",
    "flex-end",
    "center",
    "space-between",
    "space-around"
  ]),
  styleOverrides: React.PropTypes.object
};

Flex.defaultProps = {
  align: "center",
  direction: "row",
  gutters: null,
  justifyContent: "center",
  styleOverrides: null
};

Flex.Item = Item;

export default Radium(Flex);