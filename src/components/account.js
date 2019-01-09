// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import {Link} from "react-router";
import { connect } from "react-redux";
import { polisPost } from '../util/net';
import { getPlanName } from "../util/plan-features";
import Radium from "radium";
import _ from "lodash";
import Spinner from "./framework/spinner";
import StripeForm from './stripe-form';
import {s} from "./framework/global-styles";


// import Alert from 'react-s-alert';
// TODO get Alert lib working again.
const Alert = {
  error: (txt) => {
    alert(txt);
  },
};


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


function onToken(stripeResponse) {
  console.log('got token', stripeResponse);
  polisPost('/api/v3/stripe_upgrade', {
    stripeResponse: JSON.stringify(stripeResponse),
    plan: "pro",
  }).then((data) => {
    window.location.reload();
  }, (err) => {
    if (err) {
      if (err.responseText === "polis_err_stripe_card_declined") {
        Alert.error('The card was declined. Please check and try again.', {
          position: 'top-right',
          beep: false,
          timeout: 'none',
          offset: 80
        });
      } else {
        Alert.error('There was an error with code: ' + err.responseText + ' Please contact us for help.', {
          position: 'top-right',
          beep: false,
          timeout: 'none',
          offset: 80
        });
      }
    } else {
      Alert.error('There was an error. Please contact us for help.', {
        position: 'top-right',
        beep: false,
        timeout: 'none',
        offset: 80
      });
    }
  });
}

function onCancelPlan() {
  polisPost('/api/v3/stripe_cancel', {
  }).then((data) => {
    window.location.reload();
  }, (err) => {
    alert("error cancelling subscription, please contact us for help");
    console.error(err);
  });
}

@connect(state => state.user)
@Radium
class Account extends React.Component {

  cancelMarkup() {
    return (
      <div style={s.accountSection}>
        <p style={s.accountSectionHeader}>Cancellation</p>
        <p style={{maxWidth: 600}}>Cancel anytime, but you’ll lose access to all pro features, as well as data and reports from conversations you’ve started while on a paid plan. Need to talk to someone? Contact us via Intercom (that’s the blue button in the lower right).</p>
        <button style={s.secondaryButton} onClick={onCancelPlan}>Cancel Subscription</button>
      </div>
    )
  }

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
        <div style={s.accountSection}>
          <p style={s.accountSectionHeader}>Billing Overview</p>
          <p>
            Plan: {getPlanName(this.props.user)}
            <Link style={{
                marginLeft: 20,
                fontSize: 12,
                textTransform: "uppercase",
                fontWeight: 500,
                textDecoration: "none",
                color: s.brandColor,
              }} to="pricing">
              plans & pricing
            </Link>
          </p>
          { this.props.user.planCode === 0 ? <StripeForm onToken={onToken}/> : null }


        </div>

        { this.props.user.planCode > 0 ? this.cancelMarkup() : null }

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

// <p>Next payment</p>
//   <div style={s.accountSection}>
//     <p style={s.accountSectionHeader}>Payment History</p>
//     <p>List</p>
//   </div>
