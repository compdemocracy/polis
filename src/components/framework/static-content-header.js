import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import PolisLogo from "./polis-logo";
import HexLogo from "./hex-logo-tiny-long";

@connect()
@Radium
class Header extends React.Component {
  styles () {
    return {
      topBar: {
        width: "100%",
        // height: 70,
        fontSize: 18,
        fontWeight: 400,
        color: "white",
        backgroundColor: this.props.backgroundColor ? this.props.backgroundColor : "rgba(0,0,0,.3)",
        zIndex: 10,
      }
    }
  }
  render() {
    return (
      <Flex
        justifyContent={this.props.nologo ? "flex-end" : "space-between"}
        styleOverrides={this.styles().topBar}>
        {this.props.nologo ? "" : <HexLogo/>}
          <Link style={{
            textDecoration: "none",
            color: "white",
            marginRight: 20,
            marginTop: 20,
            marginBottom: 20
          }} to={"signin"}>Sign In</Link>
      </Flex>
    );
  }
}

export default Header;
