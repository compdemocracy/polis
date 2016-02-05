import React from "react";
import Radium from "radium";

/**

    order: integer,
    flexGrow: integer,
    flexShrink: integer,

    flexBasis: don't use this - poorly supported and strange behavior seems likely,
    https://www.w3.org/TR/css3-flexbox/images/rel-vs-abs-flex.svg

    alignSelf: "auto", "flex-start", "flex-end", "center", "baseline", "stretch",

**/

class FlexItem extends React.Component {
  static propTypes = {
    order: React.PropTypes.number,
    flexGrow: React.PropTypes.number,
    flexShrink: React.PropTypes.number,
    flexBasis: React.PropTypes.oneOfType([
      React.PropTypes.string,
      React.PropTypes.number
    ]),
    alignSelf: React.PropTypes.oneOf([
      "auto", "flex-start", "flex-end", "center", "baseline", "stretch"
    ]),
    children: React.PropTypes.node,
  }
  static defaultProps = {
    order: null,
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: 'auto',
    alignSelf: 'auto',
  }
  getStyles() {
    return {
      base: {
        order: this.props.order ? this.props.order : "",
        flexGrow: this.props.flexGrow,
        flexShrink: this.props.flexShrink,
        flexBasis: this.props.flexBasis,
        alignSelf: this.props.alignSelf,
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

export default Radium(FlexItem);