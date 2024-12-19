// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PropTypes from "prop-types";
import React from "react";

/**

  flex-direction: row | row-reverse | column | column-reverse;
  flex-wrap: nowrap | wrap | wrap-reverse;
  justify-content: flex-start | flex-end | center | space-between | space-around;
  align-items: flex-start | flex-end | center | baseline | stretch;
  align-content: flex-start | flex-end | center | space-between | space-around | stretch;
  flex is growShrinkBasis

**/

const Flex = ({
  direction = "row",
  wrap = "nowrap",
  justifyContent = "center",
  alignItems = "center",
  alignContent = "stretch",
  grow = 0,
  shrink = 1,
  basis = "auto",
  alignSelf = "auto",
  order = 0,
  styleOverrides = {},
  children,
  clickHandler,
}) => {
  const getStyles = () => ({
    base: {
      display: "flex",
      flexDirection: direction,
      flexWrap: wrap,
      justifyContent,
      alignItems,
      alignContent,
      order,
      flexGrow: grow,
      flexShrink: shrink,
      flexBasis: basis,
      alignSelf,
    },
    styleOverrides,
  });

  const styles = { ...getStyles().base, ...getStyles().styleOverrides };

  return (
    <div onClick={clickHandler} style={styles}>
      {children}
    </div>
  );
};

Flex.propTypes = {
  direction: PropTypes.oneOf([
    "row",
    "rowReverse",
    "column",
    "columnReverse",
  ]),
  wrap: PropTypes.oneOf(["nowrap", "wrap", "wrap-reverse"]),
  justifyContent: PropTypes.oneOf([
    "flex-start",
    "flex-end",
    "center",
    "space-between",
    "space-around",
  ]),
  alignItems: PropTypes.oneOf([
    "flex-start",
    "flex-end",
    "center",
    "baseline",
    "stretch",
  ]),
  alignContent: PropTypes.oneOf([
    "flex-start",
    "flex-end",
    "center",
    "space-between",
    "space-around",
    "stretch",
  ]),
  grow: PropTypes.number,
  shrink: PropTypes.number,
  basis: PropTypes.string,
  order: PropTypes.number,
  alignSelf: PropTypes.oneOf([
    "auto",
    "flex-start",
    "flex-end",
    "center",
    "baseline",
    "stretch",
  ]),
  styleOverrides: PropTypes.object,
  children: PropTypes.node,
  clickHandler: PropTypes.func,
};

Flex.defaultProps = {
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
  styleOverrides: {},
};

export default Flex;
