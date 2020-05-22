// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import InputField from "material-ui/TextField";
import React from "react";
import { connect } from "react-redux";
import { doPasswordReset } from "../actions";
import Radium from "radium";
import Flex from "./framework/flex";
import Button from "./framework/generic-button";
import Awesome from "react-fontawesome";
import LanderContainer from "./App/Container/LanderContainer";
import ContainerInner from "./App/Container/ContainerInner";

const styles = {
  input: {
    display: "block",
    margin: "20px 0px",
    color: "rgb(100,100,100)",
    fontSize: 14,
    padding: 7,
    borderRadius: 3,
    border: "1px solid rgb(200,200,200)",
  },
};

@connect()
@Radium
class SignIn extends React.Component {
  handleClick(e) {
    e.preventDefault();
    const attrs = {
      newPassword: this.refs.password.value,
      pwresettoken: this.props.location.pathname.slice("/pwreset/".length),
    };

    if (attrs.newPassword !== this.refs.passwordRepeat.value) {
      alert("Passwords need to match");
      return;
    }

    this.props.dispatch(doPasswordReset(attrs));
  }

  render() {
    return (
      <LanderContainer>
        <ContainerInner>
          <h1>Password Reset</h1>
          <form>
            <input style={styles.input} ref="password" placeholder="new password" type="password" />
            <input
              style={styles.input}
              ref="passwordRepeat"
              placeholder="repeat new password"
              type="password"
            />
            <Button onClick={this.handleClick.bind(this)}>Set new password</Button>
          </form>
        </ContainerInner>
      </LanderContainer>
    );
  }
}

export default SignIn;
