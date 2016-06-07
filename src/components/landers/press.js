import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Flex from "../framework/flex";
// import { connect } from "react-redux";
// import { FOO } from "../actions";


// @connect(state => {
//   return state.FOO;
// })
@Radium
class Press extends React.Component {
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
    // foo: "bar"
  }
  getStyles() {
    return {
      pressSection: {
        backgroundColor: "rgb(247,247,247)",
        color: "darkgray",
        width: "100%",
        // "@media (min-width: 768px)": {
        // }
      },
      article: {
        padding: 30
      },
      newsLogo: {
        margin: 0,
        width: 170,
        filter: "grayscale(100%) opacity(0.4)",
        ":hover": {
          filter: "none"
        }
      },
    };
  }
  render() {
    return (
      <Flex
        styleOverrides={this.getStyles().pressSection}
        direction="column"
        alignItems={"center"}>
        <Flex
          styleOverrides={{width: "100%"}}
          wrap="wrap"
          justifyContent={"space-around"}>
          <a style={this.getStyles().article} href="http://www.geekwire.com/2014/startup-spotlight-polis/">
            <img
              key="1"
              style={this.getStyles().newsLogo}
              src="http://cdn.geekwire.com/wp-content/uploads/2015/02/GeekWire-logo-transparent.png"/>
          </a>
          {/*<a style={this.getStyles().article} href="http://m.media.daum.net/m/media/world/newsview/20160302145809114">
            <img
              key="2"
              style={this.getStyles().newsLogo}
              src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Daum_communication_logo.svg/2000px-Daum_communication_logo.svg.png"/>
          </a>*/}
          <a style={this.getStyles().article} href="http://www.poynter.org/2016/here-are-27-ways-to-think-about-comments/401728/">
            <img
              key="3"
              style={this.getStyles().newsLogo}
              src="http://atendesigngroup.com/sites/all/themes/aten2014/images/logos/logo--poynter.png"/>
          </a>
          <a style={this.getStyles().article} href="http://www.mobilisationlab.org/blooming-digital-democracy-taiwan-sunflower-movement/#.Vur9oxIrLUI">
            <img
              key="4"
              style={this.getStyles().newsLogo}
              src="http://www.mobilisationlab.org/wp-content/themes/eleven40/images/logo-mob-lab-sq.png"/>
          </a>
          <a style={this.getStyles().article} href="https://coralproject.net/new-community-tools-polis/">
            <img
              key="kabillion"
              style={this.getStyles().newsLogo}
              src="https://coralproject.net/wp-content/uploads/2015/10/coralWordMark-1.5.png"/>
          </a>
        </Flex>
      </Flex>
    );
  }
}

export default Press;
