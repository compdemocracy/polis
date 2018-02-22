// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react';
import Radium from 'radium';
import Flex from '../framework/flex';
import Awesome from "react-fontawesome";
import VerifiedTwitterIcon from "../framework/verified-twitter-icon";
import colors from "../framework/colors";
import Barchart from "./summary-comment-barchart";

@Radium
class SummaryComment extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    fb_name: React.PropTypes.string,
    social: React.PropTypes.object,
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
      stats = `${Math.floor(this.props["n-success"] / this.props["n-trials"] * 100)}%`;
    } else {
      /* it's a group, so it's calculated above because complex accessor */
      stats = `${this.props.percent}%`
    }
    return stats;
  }
  getStyles() {
    return {
      image: {
        borderRadius: 100,
        height: 30,
        position: "relative",
        top: 10,
        marginRight: 7,
      },
      name: {
        fontStyle: "italic"
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
      percent: {
        color: this.props.agree ? "rgb(46, 204, 113)" : "rgb(231, 76, 60)",
      },
      percentContainer: {
        marginRight: 15,
        minWidth: 65
      },
      commentContainer: {
        fontWeight: 300
      },
      commentText: {
        fontWeight: 300
      },
      container: {
        marginTop: 20,
      }
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Flex
        styleOverrides={styles.container}
        alignItems="baseline"
        justifyContent="flex-start">
        <span style={styles.percentContainer}>
          <span style={styles.percent}>
            <Awesome name={this.props.agree ? "check-circle-o" : "ban"}/>
            {` `}
            {this.getStats()}
          </span>
        </span>
        <Flex alignSelf="baseline">
          {this.getImage()}
        </Flex>
        <span style={styles.commentContainer}>
          <span style={styles.name}>
            {this.props.social ? this.getRealName() : "Anonymous"}
          </span>
          <span>
            {this.props.social ? " • " : ""}
            {this.props.social && this.props.social.fb_user_id ? this.facebookIcon() : ""}
            {this.props.social && this.props.social.followers_count ? this.followers() : ""}
            {this.props.social && this.props.social.is_verified ? <VerifiedTwitterIcon/> : ""}
          </span>
          {` • `}
          <span style={styles.commentText}>
            {this.props.txt}
          </span>
          {
            !this.props.majority && this.props.showHowOtherGroupsFelt ? <Barchart tid={this.props.tid}/> : ""
          }
        </span>
      </Flex>
    );
  }
}

export default SummaryComment;
