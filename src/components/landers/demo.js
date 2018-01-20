// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../../actions";
import { browserHistory } from "react-router";

import Button from "../Core/Button/Button"
import FormField from "../Core/Form/FormField";

import LanderContainer from "../App/Container/LanderContainer";
import ContainerInner from "../App/Container/ContainerInner";

@connect()
class Demo extends React.Component {
  handleGetStartedClicked(r) {
    return () => {
      browserHistory.push(r);
    };
  }

  handleJoinWaitingList() {
    this.doHandleJoinWaitingListClicked({
      email: this.refs.emailupper && this.refs.emailupper.value,
      name: this.refs.nameupper && this.refs.nameupper.value,
      affiliation: this.refs.affiliationupper && this.refs.affiliationupper.value,
      role: this.refs.roleupper && this.refs.roleupper.value
    }).then(
      () => {
        this.setState(
          Object.assign({}, defaultState, {
            successTextUpper: strings("waitinglist_add_success")
          })
        );
      },
      err => {
        this.setState(
          Object.assign({}, defaultState, {
            errorTextUpper: err.responseText
          })
        );
      }
    );
  }

  doHandleJoinWaitingListClicked(data) {
    data.campaign = "home"; // @todo this needs to change!
    return PolisNet.polisPost("/api/v3/waitinglist", data);
  }

  maybeErrorMessage(text) {
    let markup = "";
    if (text) {
      markup = <div style={this.styles().error}>{strings(text)}</div>;
    }
    return markup;
  }

  maybeSuccessMessage(text) {
    let markup = "";
    if (text) {
      markup = <div style={this.styles().success}>{strings(text)}</div>;
    }
    return markup;
  }

  render() {
    return (
      <LanderContainer>
        <ContainerInner>
        <header>
          <h1>Request a Demo</h1>
        </header>
        <form className="">
          <FormField>
            <input
              placeholder="Name"
              ref="nameupper"
              type="name"
            />
          </FormField>
          <FormField>
            <input
              placeholder="Email"
              ref="emailupper"
              type="email"
            />
          </FormField>
          <FormField>
            <input
              placeholder="Organization"
              ref="affiliationupper"
              type="affiliation"
            />
          </FormField>
          <FormField>
            <input
              placeholder="Role"
              ref="roleupper"
              type="role"
            />
          </FormField>

          <Button
            onClick={this.handleJoinWaitingList.bind(this)}
          >
            Get in touch
          </Button>
          {/* <div style={{ margin: 10 }}>
            {this.maybeErrorMessage(this.state.errorTextUpper)}
            {this.maybeSuccessMessage(this.state.successTextUpper)}
          </div> */}
        </form>
        </ContainerInner>
      </LanderContainer>
    );
  }
}

export default Demo;
