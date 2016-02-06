import React, { PropTypes } from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import PolisLogo from "./polis-logo";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import BackgroundStars from "./background-stars";


const styles = (props) => {
  return {
    topBar: {
      width: "100%",
      // height: 70,
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
      // height: 50,
    },
    flexContainer: {
      height: "100vh",
      background: props.image ? "url(https://pol.is/landerImages/billions-compressor.jpeg) no-repeat center center fixed" : "",
      backgroundSize: props.image ? "cover" : ""
    },
    footerLink: {
      textDecoration: 'none',
      cursor: "pointer",
      color: "white",
      fontSize: 12
    }
  }
}

@Radium
class StaticContentContainer extends React.Component {
  static propTypes = {
    /**
     * image specifies whether a background image should be shown or not
     */
    image: PropTypes.bool,
    stars: PropTypes.object,
  };

  static defaultProps = {
    image: true,
    stars: true
  }
  render() {
    return (
      <div>
        <Flex direction="column" styleOverrides={styles(this.props).flexContainer}>
          {/* header */}
          <Flex styleOverrides={styles(this.props).topBar}>
            <PolisLogo/>
          </Flex>
            {this.props.children}
          <Flex
            growShrinkBasis="0 1 auto"
            justifyContent={"space-between"}
            styleOverrides={styles(this.props).footer}>
            <p style={{marginLeft: 20, fontSize: 12}}>© Polis Technology Inc. 2016 </p>
            <div style={{marginRight: 20}}>
              <Link
                style={styles(this.props).footerLink}
                to="/tos">
                <Awesome name="file-text-o"/>
                <span style={{marginLeft: 5}}> TOS </span>
              </Link>
              <Link
                style={styles(this.props).footerLink}
                to="/privacy">
                <span style={{marginLeft: 5}}> PRIVACY </span>
              </Link>
            </div>
          </Flex>
        </Flex>
        {this.props.stars.visible ? <BackgroundStars color={this.props.stars.color}/> : ""}
      </div>
    );
  }
}



export default StaticContentContainer;

