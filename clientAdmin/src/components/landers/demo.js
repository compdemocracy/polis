// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../../actions";
import { browserHistory } from "react-router";

import Button from "../Core/Button/Button"
import FormField from "../Core/Form/FormField";

import LanderContainer from "../App/Container/LanderContainer";
import ContainerInner from "../App/Container/ContainerInner";

import PolisNet from "../../util/net";
import strings from "../../strings/strings";

let defaultState = {
  successTextUpper: "",
  errorTextUpper: "",
};


@connect()
class Demo extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      successTextUpper : "",
      errorTextUpper : "",
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
      markup = <div>{strings(text)}</div>;
    }
    return markup;
  }

  maybeSuccessMessage(text) {
    let markup = "";
    if (text) {
      markup = <div>{strings(text)}</div>;
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
        <FormField>
          <input
            placeholder="Name"
            ref="nameupper"
            type="text"
          />
        </FormField>
        <FormField>
          <input
            placeholder="Email"
            ref="emailupper"
            type="text"
          />
        </FormField>
        <FormField>
          <input
            placeholder="Organization"
            ref="affiliationupper"
            type="text"
          />
        </FormField>
        <FormField>
          <input
            placeholder="Role"
            ref="roleupper"
            type="text"
          />
        </FormField>

          <Button
            onClick={this.handleJoinWaitingList.bind(this)}
          >
            Get in touch
          </Button>

          <div style={{ margin: 10 }}>
            {this.maybeErrorMessage(this.state.errorTextUpper)}
            {this.maybeSuccessMessage(this.state.successTextUpper)}
          </div>

        </ContainerInner>
      </LanderContainer>
    );
  }
}

export default Demo;
