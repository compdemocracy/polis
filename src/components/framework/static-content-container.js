import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import PolisLogo from "./polis-logo";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import BackgroundStars from "./background-stars";


const styles = {
  topBar: {
    width: "100%",
    fontSize: 24,
    fontWeight: 700,
    color: "white",
    backgroundColor: "rgba(0,0,0,.3)",
    position: "relative",
    zIndex: 10,
  },
  footer: {
    width: "100%",
    backgroundColor: "rgba(0,0,0,.5)",
    color: "white",
    position: "relative",
    zIndex: 10,
    minHeight: 50
  },
  flexContainer: {
    minHeight: "100vh",
    background: "url(https://pol.is/landerImages/billions-compressor.jpeg) no-repeat center center fixed",
    backgroundSize: "cover"
  },
  footerLink: {
    textDecoration: 'none',
    cursor: "pointer",
    color: "white",
    fontSize: 12
  }
}

@Radium
class StaticContentContainer extends React.Component {

  render() {
    return (
      <div style={styles.flexContainer}>
        <Flex direction="column" justifyContent="space-between" styleOverrides={{height: "100%"}}>
          <div style={styles.topBar}>
            <PolisLogo/>
          </div>
          {this.props.children}
          <Flex justifyContent={"space-between"} styleOverrides={styles.footer}>
            <p style={{marginLeft: 20, fontSize: 12}}> © Polis Technology Inc. 2016 </p>
            <div style={{marginRight: 20}}>
              <Link
                style={styles.footerLink}
                to="/tos">
                <Awesome name="file-text-o"/>
                <span style={{marginLeft: 5}}> TOS </span>
              </Link>
              <Link
                style={styles.footerLink}
                to="/privacy">
                <span style={{marginLeft: 5}}> PRIVACY </span>
              </Link>
            </div>
          </Flex>
        </Flex>
        <BackgroundStars/>
      </div>
    );
  }
}

export default StaticContentContainer;
