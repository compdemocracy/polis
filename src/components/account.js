// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { polisPost } from '../util/net';
import Radium from "radium";
import _ from "lodash";
import Spinner from "./framework/spinner";
import StripeForm from './stripe-form';
import {s} from "./framework/global-styles";


const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}


function onToken(token) {
  console.log('got token', token);
  polisPost('/api/v3/stripe_save_token', {
    token: JSON.stringify(token),
  }).then((data) => {
    console.log('We are in business, ' + data.email);
  }, (err) => {
    console.error(err);
  });
}


@connect(state => state.user)
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
          <p>{this.props.user.hasFacebook ? "Facebook is connected" : "Connect Facebook"} </p>
          <p>{this.props.user.hasTwitter ? "Twitter is connected" : "Connect Twitter"}</p>
        </div>
        <div style={s.accountSection}>
          <p style={s.accountSectionHeader}>Billing Overview</p>
          <p>Plan {" " + this.props.user.plan} <button> Upgrade </button></p>
          <StripeForm onToken={onToken}/>
          <p>Next payment</p>
        </div>
        <div style={s.accountSection}>
          <p style={s.accountSectionHeader}>Payment History</p>
          <p>List</p>
        </div>
        <div style={s.accountSection}>
          <p style={s.accountSectionHeader}>Cancel Your Plan</p>
          <p style={{maxWidth: 600}}>Cancel anytime, but you’ll lose access to all pro features, as well as data and reports from conversations you’ve started while on a paid plan. Need to talk to someone? Contact us via Intercom (that’s the blue button in the lower right).</p>
          <button style={s.dangerButton}>Cancel</button>
        </div>


      </div>
    )
  }
  render() {
    console.log(this.props.user)
    return (
      <div>
        {
          this.props.user.hname ? this.buildAccountMarkup() :
          <Spinner/>
        }
      </div>
    );
  }
}

export default Account;
