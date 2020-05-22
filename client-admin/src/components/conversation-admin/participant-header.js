// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
// import _ from 'lodash';
import Flex from "../framework/flex";
// import { connect } from 'react-redux';
// import { FOO } from '../actions';
import Awesome from "react-fontawesome";
import VerifiedTwitterIcon from "../framework/verified-twitter-icon";

// const style = {
// };

// @connect(state => {
//   return state.FOO;
// })
@Radium
class ParticipantHeader extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  getStyles() {
    return {
      image: {
        borderRadius: 3,
        width: 48,
        height: 48,
      },
      name: {
        marginLeft: 10,
        marginBottom: 3,
        fontWeight: 700,
      },
    };
  }
  getRealName() {
    let name = "[name unknown]";

    if (this.props.name) {
      name = this.props.name;
    }

    if (this.props.fb_name) {
      name = this.props.fb_name;
    }

    if (this.props.x_name) {
      name = this.props.x_name;
    }

    return name;
  }
  getImage() {
    let image = "";
    if (this.props.x_profile_image_url) {
      image = <img src={this.props.x_profile_image_url} style={this.getStyles().image} />;
    } else if (this.props.fb_user_id) {
      image = <img src={this.props.fb_picture} style={this.getStyles().image} />;
    } else if (this.props.profile_image_url_https) {
      image = <img src={this.props.profile_image_url_https} style={this.getStyles().image} />;
    } else if (this.props.twitter_profile_image_url_https) {
      image = (
        <img src={this.props.twitter_profile_image_url_https} style={this.getStyles().image} />
      );
    }
    return image;
  }
  facebookIcon() {
    return (
      <a target="_blank" href={this.props.fb_link}>
        <Awesome
          style={{
            fontSize: 24,
            color: "#3b5998",
          }}
          name={"facebook-square"}
        />
      </a>
    );
  }
  twitterIcon() {
    return (
      <a target="_blank" href={`https://twitter.com/${this.props.screen_name}`}>
        <Awesome
          style={{
            fontSize: 24,
            color: "#4099FF",
            marginLeft: 10,
          }}
          name={"twitter-square"}
        />
      </a>
    );
  }
  xIcon() {
    return <span>asdf</span>;
  }

  followers() {
    return (
      <a
        target="_blank"
        href={`https://twitter.com/${this.props.screen_name}`}
        style={{
          textDecoration: "none",
          fontWeight: 300,
          color: "black",
          marginLeft: 10,
        }}
      >
        <Awesome
          style={{
            fontSize: 16,
            color: "#4099FF",
          }}
          name={"twitter"}
        />
        <span style={{ marginLeft: 5 }}>{this.props.followers_count}</span>
      </a>
    );
  }

  render() {
    const styles = this.getStyles();
    return (
      <Flex
        styleOverrides={{ width: "100%" }}
        justifyContent="space-between"
        alignItems="flex-start"
      >
        <Flex alignItems="flex-start">
          {this.getImage()}
          <Flex direction="column" alignItems="flex-start">
            <span style={styles.name}>{this.getRealName()}</span>
            <span>{this.props.followers_count ? this.followers() : ""}</span>
          </Flex>
          {this.props.is_verified ? <VerifiedTwitterIcon /> : ""}
        </Flex>
        <div>
          {/*this.props.twitter_user_id ? this.props.followerCount : ""*/}
          {this.props.fb_user_id ? this.facebookIcon() : ""}
          {this.props.twitter_user_id ? this.twitterIcon() : ""}
          {this.props.xInfo && this.props.xInfo.x_profile_image_url ? this.xIcon() : ""}
        </div>
      </Flex>
    );
  }
}

export default ParticipantHeader;
