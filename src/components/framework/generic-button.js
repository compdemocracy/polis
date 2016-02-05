import Radium from 'radium';
import React from 'react';

@Radium
class Button extends React.Component {
  static propTypes = {
    color: React.PropTypes.string,
    backgroundColor: React.PropTypes.string,
    backgroundColorHover: React.PropTypes.string,
    backgroundColorFocus: React.PropTypes.string,
    backgroundColorActive: React.PropTypes.string
  }
  static defaultProps = {
    color: "white",
    backgroundColor: "black",
    backgroundColorHover: null,
    backgroundColorFocus: null,
    backgroundColorActive: null
  }
  getStyles() {
    return {
      base: {
        fontSize: 16,
        backgroundColor: this.props.backgroundColor,
        color: this.props.color,
        border: this.props.border ? this.props.border : 0,
        marginRight: 10,
        borderRadius: "0.3em",
        // padding: "0.4em 1em",
        padding: "0.8em 1.5em",
        cursor: "pointer",
        outline: "none",

        // '@media (min-width: 992px)': {
        //   padding: "0.6em 1.2em"
        // },

        // '@media (min-width: 1200px)': {
        //   padding: "0.8em 1.5em"
        // },

        ':hover': {
          color: this.props.textColorHover ? this.props.textColorHover : this.props.color,
          backgroundColor: this.props.backgroundColorHover ? this.props.backgroundColorHover : this.props.backgroundColor,
        },

        ':focus': {
          color: this.props.textColorFocus ? this.props.textColorFocus : this.props.color,
          backgroundColor: this.props.backgroundColorFocus ? this.props.backgroundColorFocus : this.props.backgroundColor,
        },

        ':active': {
          color: this.props.textColorActive ? this.props.textColorActive : this.props.color,
          backgroundColor: this.props.backgroundColorActive ? this.props.backgroundColorActive : this.props.backgroundColor,
          transform: "translateY(2px)",
        }
      }
    }
  }
  render() {
    const styles = this.getStyles();
    return (
      <button
        onClick={this.props.onClick}
        style={[
          styles.base,
          this.props.style
        ]}>
        {this.props.children}
      </button>
    );
  }
}

Button.propTypes = {
  color: React.PropTypes.string,
  onClick: React.PropTypes.func
};

module.exports = Button;