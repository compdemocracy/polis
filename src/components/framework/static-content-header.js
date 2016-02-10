import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import PolisLogo from "./polis-logo";

@connect()
@Radium
class Header extends React.Component {
  styles () {
    return {
      topBar: {
        width: "100%",
        // height: 70,
        fontSize: 24,
        fontWeight: 700,
        color: "white",
        backgroundColor: "rgba(0,0,0,.3)",
        zIndex: 10,
      }
    }
  }
  render() {
    return (
      <Flex styleOverrides={this.styles().topBar}>
        <PolisLogo/>
      </Flex>
    );
  }
}

export default Header;
