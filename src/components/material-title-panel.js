// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Awesome from "react-fontawesome";
import * as globals from "./framework/global-styles";
import Flex from "./framework/flex";

const styles = {
  root: {
    height: "100%"
  },
  header: {
    backgroundColor: "#03a9f4",
    color: "white",
    padding: "16px",
    fontSize: "1.5em",
    // position: "fixed",
    // width: "100%",
    minHeight: globals.headerHeight,
  },
};

const MaterialTitlePanel = (props) => {

  const rootStyle = props.style ? {...styles.root, ...props.style} : styles.root;
  return (
    <div style={rootStyle}>
      <div style={styles.header}>
        <Flex justifyContent="space-between" alignItems="center">
        {
          props.showHamburger ?
            "" :
            <div
              onClick={props.handleHamburgerClick}
              style={{
                marginRight: 15,
                display: "inline",
                fontSize: 18,
                cursor: "pointer"
              }}>
              <Awesome name="bars"/>
            </div>
        }
          { props.title }
          <Flex grow={1} justifyContent="flex-end" styleOverrides={{
              margin: 0, fontSize: 14, fontWeight: 300
            }}>
            <Awesome style={{marginRight: 7}} name="user"/>
            {props.name && props.name.split && props.name.split(" ")[0]}
          </Flex>
        </Flex>
      </div>
      {props.children}
    </div>
  );
};

export default MaterialTitlePanel;
