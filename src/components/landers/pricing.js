// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { connect } from "react-redux";
import { populateUserStore } from "../../actions";
import React from "react";
import Radium from "radium";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import StaticContentContainer from "../framework/static-content-container";
import strings from "../../strings/strings";
import _ from "lodash";
import {s} from "../framework/global-styles";

const stripeKey = /localhost|preprod.pol.is/.test(document.domain) ? "pk_test_x6ETDQy1aCvKnaIJ2dyYFVVj" : "pk_live_zSFep14gq0gqnVkKVp6vI9eM";

const styles = {
  container: {
    padding: 20,
    marginBottom: 40,
    maxWidth: "31em"
  },
  heading: {
    fontSize: 36,
    fontWeight: 300,
    display: "block",
    marginBottom: 20,
    marginTop: 0,
    textAlign: "center"
  },

};

const plans = [
  {
    name: "Professional (most popular)",
    price: "$250/mo, per seat",
    priceCents: 250*100,
    planCode: 100,
    description: "More participants. More control. More information.",
    features: [
      // "Everything in Basic",
      "Unlimited conversations",
      // "3,000 unique participants per month",
      "Seed tweets as pol.is comments",
      "Participation statistics",
      // "Extreme / moderate / group bridger participants in report ",
      "Customize interface (components & colors)",
      "Strict moderation (no comments shown without prior approval)",
      "Metadata management",
      "Moderate which participants appear in the visualization",
      "Reporting",
      "Data export",
      "Same day support",
    ]
  },
  {
    name: "Multi-Account",
    price: false,
    planCode: 1000,
    description: "Provide access to professional accounts to multiple people within your organization at a discount.",
  },
  {
    name: "Integrate",
    price: false,
    planCode: 10000,
    description: "Create conversations automatically, on your site, with your users. Good for brands & apps, as well as organizations with databases of members.",
    features: [
      "Everything in professional",
      "xid (seamless, authenticated participation)",
      "API access",
      "Create custom invitation URLs per participant (good for email campaigns)",
      "White label options",
      "Priority support",
      "System integration assistance",
    ]
  },
  {
    name: "On Site",
    price: false,
    planCode: 100000,
    description: "If data security is a requirement, we'll help install a version of pol.is on your servers. Reach out for a free consultation.",
    features: [
      "Installation",
      "Maintenance",
      "Licensing",
      "Dedicated support",
    ]
  },
]

class Plan extends React.Component {

  onToken = (token) => {
    fetch('/save-stripe-token', {
      method: 'POST',
      body: JSON.stringify(token),
    }).then(response => {
      response.json().then(data => {
        alert(`We are in business, ${data.email}`);
      });
    });
  }

  actionMarkup() {
    let actionMarkup = (<p style={{marginTop: 20, fontStyle: "italic"}}>Contact Us</p>)

    if (this.props.user && this.props.user.planCode === this.props.plan.planCode) {
      actionMarkup = (<p>"Current Plan"</p>);
    } else if (this.props.plan.planCode === 100){
      actionMarkup = (
        <div style={{marginTop: 30}}>
        <Link
          to={"/account"}
          style={s.primaryButton}>
          {this.props.plan.price}
        </Link>
        </div>
      )
    }
    return actionMarkup;
  }

  render() {

    return (
      <div style={{
        maxWidth: 600,
        marginBottom: 100,
      }}>
        <p style={{
          width: "100%",
          fontWeight: 700,
          fontSize: 24,
          padding: "0px 0px 5px 0px",
          // borderBottom: "1px solid rgb(130,130,130)",
        }}>
          {this.props.plan.name}
        </p>
        <p style={{
          fontFamily: "Georgia, serif",
        }}>
          {this.props.plan.description}
        </p>
        <div>
        {
          _.map(this.props.plan.features, (feature, i) => {
            return (
              <p style={{
                fontFamily: "Georgia, serif",
                }}
                key={i}
                >
                <Awesome
                  style={{position: "relative", top: 1, color: "#54A357", marginRight: 5}}
                  name="check-circle"/> {feature}
              </p>
            )
          })
        }
        </div>
        {this.actionMarkup()}
      </div>
    )
  }
}

@connect(state => state.user)
@Radium
class Pricing extends React.Component {

  componentWillMount() {
    this.props.dispatch(populateUserStore());
  }


  render() {
    return (
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}>
        <Flex styleOverrides={styles.container}>
          <div>
            <p style={[styles.heading, {marginTop: 20, marginBottom: 50}]}>
              Pricing
            </p>

            {
              _.map(plans, (plan) => {
                return (
                  <Plan plan={plan} user={this.props.user} key={plan.planCode}/>
                )
              })
            }
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default Pricing;
