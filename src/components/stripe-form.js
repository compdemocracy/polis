// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
// import StripeCheckout from 'react-stripe-checkout';

import Radium from "radium";
import _ from "lodash";
import {s} from "./framework/global-styles";


import {
  CardElement,
  CardNumberElement,
  CardExpiryElement,
  CardCVCElement,
  PostalCodeElement,
  StripeProvider,
  Elements,
  injectStripe,
} from 'react-stripe-elements';


const handleChange = (change) => {
  console.log('[change]', change);
};
const handleFocus = () => {
  console.log('[focus]');
};
const handleBlur = () => {
  console.log('[blur]');
};
const handleReady = () => {
  console.log('[ready]');
};


const stripeKey = /localhost|preprod.pol.is/.test(document.domain) ? "pk_test_x6ETDQy1aCvKnaIJ2dyYFVVj" : "pk_live_zSFep14gq0gqnVkKVp6vI9eM";

const price = 250;
const priceCents = price*100;


class CardSection extends React.Component {
  render() {
    return (
      <label>
        Card details
        <CardElement style={{base: {fontSize: '18px'}}} />
      </label>
    );
  }
};

const createOptions = (fontSize: string) => {
  return {
    style: {
      base: {
        fontSize,
        backgroundColor: "green",
        color: '#424770',
        letterSpacing: '0.025em',
        fontFamily: 'Source Code Pro, monospace',
        '::placeholder': {
          color: '#aab7c4',
        },
      },
      invalid: {
        color: '#9e2146',
      },
    },
  };
};

@Radium
class _CardForm extends React.Component {
  props: {
    fontSize: string,
    stripe: StripeProps,
  }
  handleSubmit = (ev) => {
    ev.preventDefault();
    this.props.stripe.createToken().then((payload) => {
      this.props.onToken(payload.token);
    });
  }
  render() {
    return (
      <form onSubmit={this.handleSubmit} style={{backgroundColor: "orange"}}>
        <label>
          Card details
          <CardElement
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onReady={handleReady}
            {...createOptions(this.props.fontSize)}
          />
        </label>
        <button>Pay</button>
      </form>
    );
  }
}
const CardForm = injectStripe(_CardForm);

@Radium
class StripeForm extends React.Component {



  render() {
    return (
      <StripeProvider apiKey={stripeKey}>
        <Elements>
          <CardForm fontSize={18} onToken={this.props.onToken}/>
        </Elements>
      </StripeProvider>
    );
  };
}

export default StripeForm;


        // <span>
        //   <span>{"$"+price+" per month"}</span>
        //   <StripeCheckout
        //     token={this.onToken}
        //     stripeKey={stripeKey}
        //     image={"https://pol.is/landerImages/clusters.png"}
        //     name={"pol.is"}
        //     description={"Upgrade to the Pro plan"}
        //     panelLabel={"Subscribe"}
        //     amount={priceCents}
        //   />
        // </span>

