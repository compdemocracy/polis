// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState } from "react";
import Color from "color";
import settings from "../../settings";


const Checkbox = ({ isChecked, color = settings.darkGray, clickHandler =  (x) => { return x }, labelWrapperColor, label, helpText }) => {

  const [checked, setChecked] = useState(isChecked);
  const [active, setActive] = useState(false);

  const activeHandler = () => {
    setActive(a => !a);
  };

  const clickHandlerInternal = () => {
    const newState = !checked;
    setChecked(newState);
    if (clickHandler) { clickHandler(newState); }
  }

  const getWrapperStyles = () => {
    return {
      display: "block",
      marginBottom: 10,
      position: "relative"
    };
  }

  const getLabelWrapperStyles = () => {
    return {
      color: labelWrapperColor,
      cursor: "pointer",
      display: "inline-block",
      fontFamily: settings.fontFamilySansSerif,
      fontSize: 14,
      fontWeight: 400,
      lineHeight: "20px",
      paddingLeft: 22,
    };
  }

  const getCheckboxStyles = () => {
    const activeColor = Color(color).lighten(0.2).hex();

    return {
      base: {
        backgroundColor: settings.gray,
        borderRadius: 2,
        display: "inline-block",
        height: 12,
        left: -17,
        position: "relative",
        top: 1,
        transition: "background-color ease .3s",
        width: 12
      },
      checkedStyle: {
        backgroundColor: color
      },
      activeStyle: {
        backgroundColor: activeColor
      }
    };
  }

  const getLabelStyles = () => {
    return {
      display: "inline",
      left: -12,
      marginRight: 4,
      position: "relative"
    };
  }

  const getHelpTextStyles = () => {
    return {
      color: "#ccc",
      cursor: "pointer",
      display: "inline",
      fontFamily: settings.fontFamilySansSerif,
      fontSize: 12,
      fontWeight: 200,
      lineHeight: "20px",
      marginLeft: 5
    };
  }


  const {base, checkedStyle, activeStyle} = getCheckboxStyles();
  const styles = Object.assign({}, base, checked ? checkedStyle : {}, active ? activeStyle : {});

  return (
    <div style={getWrapperStyles()}>
      <span
        style={getLabelWrapperStyles()}
        role="checkbox"
        onClick={clickHandlerInternal}
        onMouseDown={activeHandler}
        onMouseUp={activeHandler}
        >
        <span data-testid="checkbox" style={styles}>
        </span>
        <span style={getLabelStyles()}>
          {label}
          {helpText ? (
            <span style={getHelpTextStyles()}>
              ({helpText})
            </span>
          ) : null }
        </span>
      </span>
    </div>
  );
}

export default Checkbox;
