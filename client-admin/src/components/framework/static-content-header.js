// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";

import _ from "lodash";
import Flex from "./flex";
import { Link } from "react-router-dom";
import HexLogo from "./hex-logo-tiny-long";

@connect()
class Header extends React.Component {
  styles() {
    return {
      topBar: {
        width: "100%",
        // height: 70,
        fontSize: 18,
        fontWeight: 400,
        color: "white",
        backgroundColor: this.props.backgroundColor ? this.props.backgroundColor : "rgba(0,0,0,.3)",
        zIndex: 10,
      },
    };
  }
  render() {
    return (
      <Flex
        justifyContent={this.props.nologo ? "flex-end" : "space-between"}
        styleOverrides={this.styles().topBar}
      >
        {this.props.nologo ? "" : <HexLogo />}
        <Link
          style={{
            textDecoration: "none",
            color: "white",
            marginRight: 20,
            marginTop: 20,
            marginBottom: 20,
          }}
          to={"signin"}
        >
          Sign In
        </Link>
      </Flex>
    );
  }
}

export default Header;
