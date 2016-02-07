import React, { PropTypes } from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import PolisLogo from "./polis-logo";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import BackgroundStars from "./background-stars";
import Footer from "./footer";


const styles = (props) => {
  return {
    flexContainer: {
      minHeight: "100%",
      position: "relative",
      marginBottom: 40,
      background: props.image ? "url(https://pol.is/landerImages/billions-compressor.jpeg) no-repeat center center fixed" : "",
      backgroundSize: props.image ? "cover" : ""
    },
    topBar: {
      width: "100%",
      // height: 70,
      fontSize: 24,
      fontWeight: 700,
      color: "white",
      backgroundColor: "rgba(0,0,0,.3)",
      position: "absolute",
      zIndex: 10,
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
      <div style={{height: "100%"}}>
        <Flex direction="column" styleOverrides={styles(this.props).flexContainer}>
          {/* header */}
          <Flex styleOverrides={styles(this.props).topBar}>
            <PolisLogo/>
          </Flex>
            {this.props.children}
        </Flex>
        {this.props.stars.visible ? <BackgroundStars color={this.props.stars.color}/> : ""}
        <Footer/>
      </div>
    );
  }
}



export default StaticContentContainer;

