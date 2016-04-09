import React from 'react';
import Radium from 'radium';
// import _ from 'lodash';
import Flex from '../framework/Flex';
// import { connect } from 'react-redux';
// import { FOO } from '../actions';
import Awesome from "react-fontawesome";
import VerifiedTwitterIcon from "../framework/verified-twitter-icon";
import colors from "../framework/colors";

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
    const styles = this.getStyles();
    return (
      <a
        target="_blank" href={`https://twitter.com/${this.props.screen_name}`}
        style={styles.twitterLink}>
        <Awesome
          style={styles.twitterIcon}
          name={"twitter"} />
        <span style={styles.followerCount}>
          {this.props.social.followers_count}
        </span>
      </a>
    );
  }
  getStats() {
    const styles = this.getStyles();
    let stats;
    if (this.props.majority) {
      /* it's consensus */
      stats = (
        <span style={styles.stat}>
          {`${Math.floor(this.props["n-success"] / this.props["n-trials"] * 100)}%`}
        </span>
      );
    } else {
      /* it's a group, so it's calculated above because complex accessor */
      stats = (
        <span style={styles.stat}>
          {`${this.props.percent}%`}
        </span>
      )
    }
    return stats;
  }
  getStyles() {
    return {
      image: {
        borderRadius: 100,
        height: 25,
        position: "relative",
        top: 7,
        marginRight: 7,
        marginLeft: 5
      },
      icons: {
        // marginLeft: this.props.social ? 8 : 0
        // marginLeft: 8
      },
      name: {
        // marginLeft: this.props.social ? 5 : 0,
        fontWeight: 300,
      },
      container: {
        marginLeft: 30
      },
      twitterLink: {
        textDecoration: "none",
        fontWeight: 300,
        color: "black",
        marginLeft: this.props.social && this.props.social.fb_user_id ? 10 : 0,
      },
      twitterIcon: {
        fontSize: 16,
        color: "#4099FF",
      },
      followerCount: {
        marginLeft: 5
      },
      stat: {
        color: this.props.agree ? "rgb(46, 204, 113)" : "rgb(231, 76, 60)",
        // padding: "3px 6px",
        // borderRadius: 3,
        // color: "white"
      },
      dot: {
        fontSize: 24
      },
      commentText: {
        fontWeight: 300
      }
    };
  }
  render() {
    // social={comments[comment.tid].social}
    // comment={comments[comment.tid].txt}
    const styles = this.getStyles();
    return (
      <p style={styles.container}>
        {this.getStats()}
        {` `}
        {this.getImage()}
        <span style={styles.name}>
          {this.props.social ? this.getRealName() : "Anonymous"}
          <span style={styles.icons}>
            {this.props.social ? <span style={styles.dot}>{` · `}</span> : ""}
            {this.props.social && this.props.social.fb_user_id ? this.facebookIcon() : ""}
            {this.props.social && this.props.social.followers_count ? this.followers() : ""}
            {this.props.social && this.props.social.is_verified ? <VerifiedTwitterIcon/> : ""}
          </span>
          <span style={styles.dot}>{` · `}</span>
        </span>
        <span style={styles.commentText}>{this.props.txt}</span>
      </p>
    );
  }
}

export default SummaryComment;
