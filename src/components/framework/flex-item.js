import React from "react";
import Radium from "radium";

/**
  The <Flex> component automatically wraps each of its children in a <Flex.Item> component.
  <Flex.Item> will inherit `gutters`, `fit`, and `full` props from the <Flex> component.

  Modifiers:
  ----------

  AutoSize:
  autoSize="true" - Items without sizing will simply divide up the remaining space as normal

  Fit:
  fit={true}  - Each Item will fit on one row and have the same width

  Full-width:
  full={true} - Each Item will be full-width

  Small:
  small={1}  - Column count on small screens

  Medium:
  medium={2}  - Column count on medium screens

  Large:
  large={4}  - Column count on large screens

  Usage:
  ----------
  <Flex.Item large={3} medium={2} small={1}>
    I’m a silly cell!
  </Flex.Item>
**/

class Item extends React.Component {
  getFlex(sizeProp) {
    switch (sizeProp) {
    case 1: return "0 0 100%";
    case 2: return "0 0 50%";
    case 3: return "0 0 33.3333%";
    case 4: return "0 0 25%";
    case "autoSize": return "none";
    }
  }

  getStyles() {
    return {
      base: {
        boxSizing: "border-box",
        flex: "0 0 100%",
        "@media (min-width: 24em)": this.props.small ? {
          flex: this.getFlex(this.props.small)
        } : null,
        "@media (min-width: 36em)": this.props.medium ? {
          flex: this.getFlex(this.props.medium)
        } : null,
        "@media (min-width: 48em)": this.props.large ? {
          flex: this.getFlex(this.props.large)
        } : null
      },
      autoSize: {
        flex: "none"
      },
      gutters: {
        padding: this.props.gutters + "em 0 0 " + this.props.gutters + "em"
      },
      fit: {
        flex: 1
      },
      full: {
        flex: "0 0 100%"
      },
      flex: {
        flex: this.props.flex
      },
      styleOverrides: this.props.styleOverrides
    };
  }

  render() {
    const styles = this.getStyles();

    return (
      <div
        style={[
          styles.base,
          this.props.autoSize && styles.autoSize,
          this.props.fit && styles.fit,
          this.props.full && styles.full,
          this.props.flex && styles.flex,
          this.props.gutters && styles.gutters,
          this.props.styleOverrides && styles.styleOverrides
        ]}>
        {this.props.children}
      </div>
    );
  }
}

Item.propTypes = {
  autoSize: React.PropTypes.bool,
  children: React.PropTypes.node,
  fit: React.PropTypes.bool,
  flex: React.PropTypes.string,
  full: React.PropTypes.bool,
  gutters: React.PropTypes.number,
  large: React.PropTypes.oneOf([1, 2, 3, 4, "autoSize"]),
  medium: React.PropTypes.oneOf([1, 2, 3, 4, "autoSize"]),
  small: React.PropTypes.oneOf([1, 2, 3, 4, "autoSize"]),
  styleOverrides: React.PropTypes.object
};

Item.defaultProps = {
  autoSize: false,
  fit: false,
  flex: null,
  full: false,
  gutters: null,
  large: null,
  medium: null,
  small: null,
  styleOverrides: null
};

export default Radium(Item);