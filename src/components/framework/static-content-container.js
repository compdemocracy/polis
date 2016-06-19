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

// @connect(state => {
//   return state.FOO;
// })
@Radium
class StaticContentContainer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    // dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    image: true,
    stars: true,
  }
  getStyles() {
    return {
      flexContainer: {
        minHeight: "100%",
        background: this.props.image ? "url(https://pol.is/landerImages/billions-compressor.jpeg) no-repeat center center fixed" : "",
        backgroundSize: this.props.image ? "cover" : ""
      }
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Flex
        styleOverrides={[
          styles.flexContainer,
          this.props.style
        ]}
        justifyContent="space-between"
        direction="column"
        styleOverrides={styles.flexContainer}>
        <Header nologo={this.props.nologo} backgroundColor={this.props.headerBackgroundColor}/>
        {this.props.children}
        <Footer backgroundColor={this.props.footerBackgroundColor}/>
      </Flex>
    );
  }
}

export default StaticContentContainer;
