import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import HexLogo from "./hex-logo-large-short";

const RadiumLink = Radium(Link);

@connect()
@Radium
class Footer extends React.Component {
  styles () {
    return {
      container: {
        backgroundColor: "#03a9f4",
        width: "100%",
        margin: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        "@media (min-width: 768px)": {

        }
      },
      innerContainer: {
        margin: "60px 100px",
        display: "flex",
        flexDirection: "column",
        alignItems: "baseline",
        justifyContent: "space-around",
        "@media (min-width: 768px)": {
          width: "100%",
          flexDirection: "row",
          alignItems: "flex-start",
        }
      },
      link: {
        textDecoration: "none",
        color: "white",
        fontWeight: 300,
      },
      header: {
        fontWeight: 700,
        color: "white",
        fontSize: "1.7em"
      },
      copyright: {
        width: "100%",
        textAlign: "center",
        fontWeight: 300,
        color: "white",
        marginBottom: 20
      }
    }
  }
  render() {
    return (
      <div style={this.styles().container}>
        <div style={this.styles().innerContainer}>
          <HexLogo invert/>
          <div>
            <p style={this.styles().header}> pol.is </p>
            <p><a style={this.styles().link} href="https://pol.is"> Home </a></p>
            <p><a style={this.styles().link} href="https://pol.is/company"> Company </a></p>
            <p><a style={this.styles().link} href="https://pol.is/company#press"> Press </a></p>
            <p><a style={this.styles().link} href="http://docs.pol.is"> Docs </a></p>
            <p><a style={this.styles().link} href="https://github.com/pol-is/"> Github </a></p>
            <p><a style={this.styles().link} href="https://github.com/pol-is/polisServer/blob/master/app.js"> API </a></p>
          </div>
          <div>
            <p style={this.styles().header}> web </p>
            <p><a style={this.styles().link} href="https://pol.is/createuser"> Sign up </a></p>
            <p><a style={this.styles().link} href="https://pol.is/signin"> Sign in </a></p>
          </div>
          <div>
            <p style={this.styles().header}> connect </p>
            <p><a style={this.styles().link} href="https://twitter.com/usepolis"> <Awesome name="twitter"/> Twitter </a></p>
            <p><a style={this.styles().link} href="https://blog.pol.is/"> <Awesome name="medium"/> Medium </a></p>
          </div>
          <div>
            <p style={this.styles().header}> legal </p>
            <p><a style={this.styles().link} href="https://pol.is/tos"> Terms & Conditions </a></p>
            <p><a style={this.styles().link} href="https://pol.is/privacy"> Privacy Policy </a></p>
          </div>
        </div>
        <p style={this.styles().copyright}> @ 2016 Polis Technology Inc. All Rights Reserved. Patent Pending. </p>
      </div>
    );
  }
}

export default Footer;

// footer: {
//   // position: "absolute",
//   // bottom: "0",
//   width: "100%",
//   backgroundColor: this.props.backgroundColor ? this.props.backgroundColor : "rgba(0,0,0,.5)",
//   color: "white",
//   zIndex: 10,
//   height: 40,
// },
// link: {
//   textDecoration: 'none',
//   cursor: "pointer",
//   color: "white",
//   fontSize: 12
// }

// <p style={{marginLeft: 20, fontSize: 12}}>© Polis Technology Inc. 2016 </p>
// <div style={{marginRight: 20}}>
//   <Link
//     style={this.styles(this.props).link}
//     to="/tos">
//     <Awesome name="file-text-o"/>
//     <span style={{marginLeft: 5}}> TOS </span>
//   </Link>
//   <Link
//     style={this.styles(this.props).link}
//     to="/privacy">
//     <span style={{marginLeft: 5}}> PRIVACY </span>
//   </Link>
// </div>
