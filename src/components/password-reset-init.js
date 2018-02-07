// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doPasswordResetInit } from "../actions";
import Radium from "radium";
import Button from "./framework/generic-button";

import LanderContainer from "./App/Container/LanderContainer";
import ContainerInner from "./App/Container/ContainerInner";

const styles = {
  button: {
    backgroundColor: "cornflowerblue",
  },
  input: {
    display: "block",
    margin: "20px 0px",
    color: "rgb(100,100,100)",
    fontSize: 14,
    padding: 7,
    borderRadius: 3,
    border: "1px solid rgb(200,200,200)",
  },
}

@connect()
@Radium
class PasswordResetInit extends React.Component {

  handleClick(e) {

    e.preventDefault();

    const attrs = {
      email: this.refs.email.value,
    };

    this.props.dispatch(doPasswordResetInit(attrs));
  }

  render() {
    return (
      <LanderContainer>
        <ContainerInner>
            <h1> Password Reset</h1>
            <form>
              <input
                style={styles.input}
                ref="email"
                placeholder="email"
                type="text"/>
              <Button style={styles.button} onClick={this.handleClick.bind(this)}>
                Send password reset email
              </Button>
            </form>
        </ContainerInner>
      </LanderContainer>
    );
  }
}

export default PasswordResetInit;
