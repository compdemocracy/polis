import React from 'react';
import Radium from 'radium';
// import _ from 'lodash';
import Flex from '../framework/Flex';
// import { connect } from 'react-redux';
// import { FOO } from '../actions';
import Awesome from "react-fontawesome";
import VerifiedTwitterIcon from "../framework/verified-twitter-icon";
import colors from "../framework/colors";

// const style = {
// };

// @connect(state => {
//   return state.FOO;
// })
@Radium
class SummaryComment extends React.Component {
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
    fb_name: React.PropTypes.string,
    social: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }

  getRealName() {
    let name = "";

    if (this.props.social && this.props.social.name) {
      name = this.props.social.name;
    }

    if (this.props.social && this.props.social.fb_name) {
      name = this.props.social.fb_name;
    }

    return name;
  }
  getImage() {
    let image = "";
    if (this.props.social && this.props.social.fb_user_id) {
      image = (
        <img src={this.props.social.fb_picture} style={this.getStyles().image}/>
      )
    } else if (this.props.social && this.props.social.profile_image_url_https) {
      image = (
        <img src={this.props.social.profile_image_url_https} style={this.getStyles().image}/>
      )
    } else if (this.props.social && this.props.social.twitter_profile_image_url_https) {
      image = (
        <img src={this.props.social.twitter_profile_image_url_https} style={this.getStyles().image}/>
      )
    }
    return image;
  }
  facebookIcon() {
    return (
      <a target="_blank" href={this.props.fb_link}>
        <Awesome
          style={{
            fontSize: 14,
            color: "#3b5998",

          }}
          name={"facebook"} />
      </a>
    );
  }

  followers() {
    return (
      <a
        target="_blank" href={`https://twitter.com/${this.props.screen_name}`}
        style={{
            textDecoration: "none",
            fontWeight: 300,
            color: "black",
            marginLeft: 10
          }}>
        <Awesome
          style={{
            fontSize: 16,
            color: "#4099FF",
          }}
          name={"twitter"} />
        <span style={{marginLeft: 5}}>
          {this.props.social.followers_count}
        </span>
      </a>
    );
  }
  getStats() {

  }
  getStyles() {
    return {
      image: {
        borderRadius: 100,
        height: 25,
        position: "relative",
        top: 7,
        marginRight: 8
      },
      icons: {
        // marginLeft: this.props.social ? 8 : 0
        // marginLeft: 8
      },
      name: {
        marginLeft: this.props.social ? 5 : 0,
        fontWeight: 500,
      },
      container: {
        marginLeft: this.props.first ? 0 : 5,
        lineHeight: 2.3
      }
    };
  }
  render() {
    // social={comments[comment.tid].social}
    // comment={comments[comment.tid].txt}
    const styles = this.getStyles();
    return (
      <span style={styles.container}>
        {this.getImage()}
        <span style={styles.icons}>
          {this.props.social && this.props.social.fb_user_id ? this.facebookIcon() : ""}
          {this.props.social && this.props.social.followers_count ? this.followers() : ""}
          {this.props.social && this.props.social.is_verified ? <VerifiedTwitterIcon/> : ""}
        </span>
        <span style={styles.name}>
          {this.props.social ? this.getRealName() : "Anonymous"}
          {": "}
        </span>
        {this.props.txt}
        {this.getStats()}
      </span>
    );
  }
}

export default SummaryComment;

/*

propTypes: {
    // You can declare that a prop is a specific JS primitive. By default, these
    // are all optional.
    optionalArray: React.PropTypes.array,
    optionalBool: React.PropTypes.bool,
    optionalFunc: React.PropTypes.func,
    optionalNumber: React.PropTypes.number,
    optionalObject: React.PropTypes.object,
    optionalString: React.PropTypes.string,

    // Anything that can be rendered: numbers, strings, elements or an array
    // (or fragment) containing these types.
    optionalNode: React.PropTypes.node,

    // A React element.
    optionalElement: React.PropTypes.element,

    // You can also declare that a prop is an instance of a class. This uses
    // JS's instanceof operator.
    optionalMessage: React.PropTypes.instanceOf(Message),

    // You can ensure that your prop is limited to specific values by treating
    // it as an enum.
    optionalEnum: React.PropTypes.oneOf(['News', 'Photos']),

    // An object that could be one of many types
    optionalUnion: React.PropTypes.oneOfType([
      React.PropTypes.string,
      React.PropTypes.number,
      React.PropTypes.instanceOf(Message)
    ]),

    // An array of a certain type
    optionalArrayOf: React.PropTypes.arrayOf(React.PropTypes.number),

    // An object with property values of a certain type
    optionalObjectOf: React.PropTypes.objectOf(React.PropTypes.number),

    // An object taking on a particular shape
    optionalObjectWithShape: React.PropTypes.shape({
      color: React.PropTypes.string,
      fontSize: React.PropTypes.number
    }),

    // You can chain any of the above with `isRequired` to make sure a warning
    // is shown if the prop isn't provided.
    requiredFunc: React.PropTypes.func.isRequired,

    // A value of any data type
    requiredAny: React.PropTypes.any.isRequired,

*/
