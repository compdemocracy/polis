// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import BackgroundStars from "../framework/background-stars";
import Button from "../framework/generic-button";
import Flex from "../framework/flex";
import InputField from "material-ui/lib/text-field";
import PolisLogo from "../framework/polis-logo";
import PolisNet from "../../util/net";
import Press from "./press";
import Radium from "radium";
import React from "react";
import StaticContentContainer from "../framework/static-content-container";
import Step from "./step";
import strings from "../../strings/strings";
import { browserHistory } from "react-router";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../../actions";
import HexLogoLargeShort from "../framework/hex-logo-large-short";
import Nav from "../App/Nav/Nav";


const Dots = () => {
  return (
    <Flex styleOverrides={{width: "100%", marginTop: 30, marginBottom: 20}} justifyContent="center">
      <svg width="65px" height="5px" viewBox="0 0 65 5">
        <g id="Page-1" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
          <g id="Desktop-HD-Copy-2" transform="translate(-975.000000, -1073.000000)" fill="#D8D8D8">
            <g id="Group" transform="translate(975.000000, 1073.000000)">
              <circle id="Oval-3" cx="2.5" cy="2.5" r="2.5"></circle>
              <circle id="Oval-3" cx="32.5" cy="2.5" r="2.5"></circle>
              <circle id="Oval-3" cx="62.5" cy="2.5" r="2.5"></circle>
            </g>
          </g>
        </g>
      </svg>
    </Flex>
  )
}


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
    return (
      <main>
        <Nav />

    <section>
          <h2>Used by</h2>


        </section>
        <section>
          <h1>Value Props</h1>
        </section>
        <aside>
          <h3>Request a Demo</h3>
          <button>Request a Demo</button>
        </aside>
        <aside>
          <h1>Press</h1>
        </aside>
      </main>
    );
  }
}

export default Home;
