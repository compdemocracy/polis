// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import StaticContentContainer from "../framework/static-content-container";
import strings from "../../strings/strings";
import _ from "lodash";

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
    name: "Basic",
    price: "Free",
    description: "The core experience, on our site or embedded on yours. Free.",
    features: [
      "3 conversations per month",
      "100 participants per conversation",
      "Seed comments",
      "Moderate comments",
    ]
  },
  {
    name: "Professional",
    price: "$250/mo",
    description: "More participants. More control. More information.",
    features: [
      "Everything in Basic",
      "Unlimited conversations",
      "Unlimited participants",
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
    description: "Provide access to professional accounts to multiple people within your organization at a discount.",
  },
  {
    name: "Integrate",
    price: false,
    description: "Create conversations automatically, on your site, with your users. Good for brands & apps, as well as organizations with databases of members.",
    features: [
      "Everything in Advanced",
      "xid (seamless, authenticated participation)",
      "API",
      "Create custom invitation URLs per participant (good for email campaigns)",
      "White label options",
      "Priority support",
      "System integration assistance",
    ]
  },
  {
    name: "On Site",
    price: false,
    description: "If data security is a requirement, we'll help install a version of pol.is on your servers. Reach out for a free consultation.",
    features: [
      "Installation",
      "Maintenance",
      "Licensing",
      "Dedicated support",
    ]
  },
]

const Plan = ({plan}) => {
  return (
    <div style={{
      maxWidth: 300,
      boxShadow: "0px 0px 20px 2px rgba(210,210,210,1)",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 20,
    }}>
      <p style={{
        width: "100%",
        textAlign: "center",
        padding: "0px 0px 5px 0px",
        // borderBottom: "1px solid rgb(130,130,130)",
      }}>
        {plan.name}
      </p>
      <p style={{
        padding: "0px 10px",
        fontFamily: "Georgia, serif",
      }}>
        {plan.description}
      </p>
      {
        _.map(plan.features, (feature) => {
          return (
            <p style={{
              padding: "0px 10px",
              fontFamily: "Georgia, serif",
            }}>
              <Awesome
                style={{position: "relative", top: 1, color: "#54A357", marginRight: 5}}
                name="check-circle"/> {feature}
            </p>
          )
        })
      }
      <p style={{
        width: "100%",
        textAlign: "center",
        padding: "15px 0px 15px 0px",
        margin: 0,
        color: "white",
          // borderTop: "1px solid rgb(130,130,130)",
        backgroundColor: "#03a9f4",
      }}>
        {plan.price ? plan.price : "Contact Us"}
      </p>
    </div>
  )
}


@Radium
class Pricing extends React.Component {

  render() {
    return (
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}>
        <Flex styleOverrides={styles.container}>
          <div>
            <p style={[styles.heading, {marginTop: 20, marginBottom: 30}]}>
              Pricing
            </p>
            {
              _.map(plans, (plan) => {
                return (
                  <Plan plan={plan}/>
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
