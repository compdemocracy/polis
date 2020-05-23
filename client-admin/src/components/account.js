// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { Link } from "react-router-dom";
import { connect } from "react-redux";
import { polisPost } from "../util/net";
import { getPlanName } from "../util/plan-features";
import Radium from "radium";
import _ from "lodash";
import Spinner from "./framework/spinner";
import { s } from "./framework/global-styles";

@connect((state) => state.user)
@Radium
class Account extends React.Component {
  buildAccountMarkup() {
    // probably a component / series of them
    return (
      <div style={s.accountContainer}>
        <p style={s.accountSection}>Hi {this.props.user.hname.split(" ")[0]}!</p>

        <div style={s.accountSection}>
          <p style={s.accountSectionHeader}>Social</p>
          <p>{this.props.user.hname}</p>
          <p>{this.props.user.email}</p>
          <p>{this.props.user.hasFacebook ? "Facebook is connected" : ""} </p>
          <p>{this.props.user.hasTwitter ? "Twitter is connected" : ""}</p>
        </div>
      </div>
    );
  }
  render() {
    console.log(this.props.user);
    return <div>{this.props.user.hname ? this.buildAccountMarkup() : <Spinner />}</div>;
  }
}

export default Account;
