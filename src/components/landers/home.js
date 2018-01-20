// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { browserHistory } from "react-router";
import { connect } from "react-redux";

import PolisNet from "../../util/net";
import strings from "../../strings/strings";
import { doSignin, doFacebookSignin } from "../../actions";

import Nav from "../App/Nav/Nav";
import FeatureSection from "./Features/FeatureSection";
import Footer from "../App/Footer/Footer";
import FooterData from '../../strings/footer'
import Hero from "./Hero/Hero";
import Trust from "./Trust/Trust";


let defaultState = {
  successTextUpper: "",
  successTextLower: "",
  errorTextUpper: "",
  errorTextLower: "",
};

@connect()
class Home extends React.Component {

  handleJoinWaitingListClickedUpper() {
    this.doHandleJoinWaitingListClicked({
      email: this.refs.emailupper && this.refs.emailupper.value,
      name: this.refs.nameupper && this.refs.nameupper.value,
      affiliation: this.refs.affiliationupper && this.refs.affiliationupper.value,
      role: this.refs.roleupper && this.refs.roleupper.value,
    }).then(() => {
      this.setState(Object.assign({}, defaultState, {
        successTextUpper: strings("waitinglist_add_success"),
      }));
    }, (err) => {
      this.setState(Object.assign({}, defaultState, {
        errorTextUpper: err.responseText,
      }));
    });
  }
  handleJoinWaitingListClickedLower() {
    this.doHandleJoinWaitingListClicked({
      email: this.refs.emaillower && this.refs.emaillower.value,
      name: this.refs.namelower && this.refs.namelower.value,
      affiliation: this.refs.affiliationlower && this.refs.affiliationlower.value,
      role: this.refs.rolelower && this.refs.rolelower.value,
    }).then(() => {
      this.setState(Object.assign({}, defaultState, {
        successTextLower: strings("waitinglist_add_success"),
      }));
    }, (err) => {
      this.setState(Object.assign({}, defaultState, {
        errorTextLower: err.responseText,
      }));
    });
  }
  doHandleJoinWaitingListClicked(data) {
    data.campaign = "home";
    return PolisNet.polisPost("/api/v3/waitinglist", data);
  }
  maybeErrorMessage(text) {
    let markup = "";
    if (text) {
      markup = (
        <div style={this.styles().error}>
          { strings(text) }
        </div>
      );
    }
    return markup;
  }
  maybeSuccessMessage(text) {
    let markup = "";
    if (text) {
      markup = (
        <div style={this.styles().success}>
          { strings(text) }
        </div>
      );
    }
    return markup;
  }
  render() {
    return <main>
        <Nav />
        <Hero headline="Know what your organization is thinking" subheadline="Polis helps organizations understand themselves. Get a summary visualization of all the viewpoints to move a conversation forward." className="page-header mt6 mt5-ns" />
        <Trust headline="You’re in good company" subheadline="Polis is trusted by governments, universities, non-profits, movements, and large organizations." />
        <FeatureSection />

        <aside>
          <h3>Request a Demo</h3>
          <button>Request a Demo</button>
        </aside>
        <aside>
          <h1>Press</h1>
        </aside>
        <Footer social={FooterData.footer.social} content={FooterData.footer.groups} data={FooterData.footer} />
      </main>;
  }
}

export default Home;
