// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
      styleOverrides: this.props.styleOverrides,
    };
  }

  render() {
    const styles = this.getStyles();

    return (
      <div onClick={this.props.clickHandler} style={[styles.base, styles.styleOverrides]}>
        {this.props.children}
      </div>
    );
  }
}

export default Radium(Flex);
