import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import Awesome from "react-fontawesome";
import {Link} from "react-router";


@connect()
@Radium
class Footer extends React.Component {
  styles () {
    return {
      footer: {
        position: "absolute",
        bottom: "0",
        width: "100%",
        backgroundColor: "rgb(100,100,100)",
        color: "white",
        zIndex: 10,
        height: 40,
      },
      footerLink: {
        textDecoration: 'none',
        cursor: "pointer",
        color: "white",
        fontSize: 12
      }
    }
  }
  render() {
    return (
      <div
        style={this.styles(this.props).footer}>
        <Flex justifyContent={"space-between"} alignItems={"baseline"}>
          <p style={{marginLeft: 20, fontSize: 12}}>© Polis Technology Inc. 2016 </p>
          <div style={{marginRight: 20}}>
            <Link
              style={this.styles(this.props).footerLink}
              to="/tos">
              <Awesome name="file-text-o"/>
              <span style={{marginLeft: 5}}> TOS </span>
            </Link>
            <Link
              style={this.styles(this.props).footerLink}
              to="/privacy">
              <span style={{marginLeft: 5}}> PRIVACY </span>
            </Link>
          </div>
        </Flex>
      </div>
    );
  }
}

export default Footer;
