// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Awesome from "react-fontawesome";
import * as globals from "./framework/global-styles";
import HexLogoTinyShort from "./framework/hex-logo-tiny-short";

const styles = {
  root: {
    fontFamily: '"HelveticaNeue-Light", "Helvetica Neue Light", "Helvetica Neue", Helvetica, Arial, "Lucida Grande", sans-serif',
    fontWeight: 300,
  },
  header: {
    backgroundColor: "#03a9f4",
    color: "white",
    fontSize: "1.5em",
    paddingTop: 8,
    display: "flex",
    justifyContent: "center",
    paddingBottom: 2,
  },
  linkout: {
  }
};

const MaterialTitlePanelSidebar = (props) => {

  const rootStyle = props.style ? {...styles.root, ...props.style} : styles.root;
  return (
    <div style={rootStyle}>
      <div id="76876876" style={styles.header}>
        <a style={styles.linkout} target="blank" href={"https://"+props.title}>
            <HexLogoTinyShort/>
        </a>
      </div>
      {props.children}
    </div>
  );
};

export default MaterialTitlePanelSidebar;
