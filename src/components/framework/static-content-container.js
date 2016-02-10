import React, { PropTypes } from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import BackgroundStars from "./background-stars";
import Header from "./static-content-header";
import Footer from "./static-content-footer";


const styles = (props) => {
  return {
    flexContainer: {
      minHeight: "100%",
      background: props.image ? "url(https://pol.is/landerImages/billions-compressor.jpeg) no-repeat center center fixed" : "",
      backgroundSize: props.image ? "cover" : ""
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
        <Flex
          justifyContent="space-between"
          direction="column"
          styleOverrides={styles(this.props).flexContainer}>
          <Header/>
          {this.props.children}
          <Footer/>
        </Flex>
    );
  }
}



export default StaticContentContainer;
