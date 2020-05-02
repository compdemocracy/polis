// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import Radium from "radium";
import React from "react";
import Color from "color";

@Radium
class Button extends React.Component {
  static propTypes = {
    style: React.PropTypes.object
  }
  static defaultProps = {
    style: {
      backgroundColor: "orange",
      color: "white"
    }
  }
  getStyles() {
    return {
      base: {
        fontSize: 16,
        backgroundColor: this.props.style.backgroundColor,
        color: this.props.style.color,
        border: this.props.style.border ? this.props.style.border : 0,
        borderRadius: "0.3em",
        // padding: "0.4em 1em",
        padding: "0.8em 1.5em",
        cursor: "pointer",
        outline: "none",

        ":hover": {
          backgroundColor: Color(this.props.style.backgroundColor).darken(.1).rgbString()
        },

        ":focus": {
          backgroundColor: Color(this.props.style.backgroundColor).darken(.2).rgbString()
        },

        ":active": {
          backgroundColor: Color(this.props.style.backgroundColor).darken(.2).rgbString(),
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
