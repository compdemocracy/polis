// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../actions";
import Radium from "radium";
import {Link} from "react-router";
import { SocialIcon } from "tachyons-react-social-icons";

import Button from "./framework/generic-button";
import LanderContainer from "./App/Container/LanderContainer";
import ContainerInner from "./App/Container/ContainerInner";

import strings from "../strings/strings";

const styles = {
  button: {
    display: "block",
    backgroundColor: "#03a9f4",
    color: "white"
  },
  input: {
    display: "block",
    margin: "10px 0px",
    color: "rgb(100,100,100)",
    fontSize: 14,
    padding: 7,
    borderRadius: 3,
    border: "1px solid rgb(130,130,130)",
  },
  facebookButton: {
    border: 0,
    color: "white",
    backgroundColor: "#3b5998",
    fontWeight: 300,
    padding: "8px 12px",
    borderRadius: 5,
    fontSize: 14,
  },
  signupContainer: {
    marginTop: 20,
  },
  signupLink: {
    color: "rgb(130,130,130)",
    textDecoration: "underline"
  },
  error: {
    margin: "20px 0px"
  },
  termsSmallprint: {
    fontSize: 12,
    maxWidth: 400,
    fontWeight: 300,
    lineHeight: 1.3,
    color: "rgb(130,130,130)"
  },
};

@connect(state => state.signin)
@Radium
class SignIn extends React.Component {

  getDest() {
    return this.props.location.pathname.slice("/signin".length);
  }

  handleLoginClicked(e) {
    e.preventDefault();
    const attrs = {
      email: this.refs.email.value,
      password: this.refs.password.value
    }

    var dest = this.getDest();
    if (!dest.length) {
      dest = "/";
    }
    this.props.dispatch(doSignin(attrs, dest));
  }

  facebookButtonClicked() {
    var dest = this.getDest();
    if (!dest.length) {
      dest = "/";
    }
    this.props.dispatch(doFacebookSignin(dest))
  }

  handleFacebookPasswordSubmit() {
    var dest = this.getDest();
    if (!dest.length) {
      dest = "/";
    }
    const optionalPassword = this.refs.facebook_password.value
    this.props.dispatch(doFacebookSignin(dest, optionalPassword))
  }

  maybeErrorMessage() {
    let markup = ""
    if (this.props.error) {
      markup = (
        <div style={styles.error}>
          { strings(this.props.error.responseText) }
        </div>
      );
    }
    return markup;
  }
  drawLoginForm() {
    return (
      <div className="w-100 w-50-ns">
        <form className="mb4">
          <input
            style={styles.input}
            ref="email"
            placeholder="email"
            type="email"/>
          <input
            style={styles.input}
            ref="password"
            placeholder="password"
            type="password"/>
          {this.maybeErrorMessage()}
          <Button style={styles.button} onClick={this.handleLoginClicked.bind(this)}>
            {this.props.pending ? "Signing in..." : "Sign In"}
          </Button>
        <p style={styles.signupContainer}>
          {"Forgot your password? "}
          <Link style={styles.signupLink} to={"/pwresetinit"}>
            Reset Password
          </Link>
        </p>

        </form>
        <div className="bt b--light-gray pt3">
          <Button
            style={styles.facebookButton}
            onClick={this.facebookButtonClicked.bind(this)}>
              <SocialIcon
                key="icon-facebook"
                network="facebook"
                color="white"
                className="mr3"
              />          
            <span>{"Sign in with Facebook"}</span>
          </Button>
          <p className="mt4 mb3 lh-copy">
            {
              "If you click 'Sign in with Facebook' and are not a pol.is user, you will be registered and you agree to the pol.is terms and privacy policy"
            }
          </p>
        </div>
      </div>
    )
  }

  drawPasswordConnectFacebookForm() {
    return (
      <span>
        <p
          style={{
            fontSize: 16,
            maxWidth: 400,
            fontWeight: 100,
            lineHeight: 1.4
          }}>
          {
            "A pol.is user already exists with the email address associated with this Facebook account."
          }
        </p>
        <p
          style={{
            fontSize: 16,
            maxWidth: 400,
            fontWeight: 100,
            lineHeight: 1.4
          }}>
          {
            "Please enter the password to your pol.is account to enable Facebook login."
          }
        </p>
        <input
          style={styles.input}
          ref="facebook_password"
          placeholder="polis password"
          type="password"/>
          <Button
            style={styles.button}
            onClick={this.handleFacebookPasswordSubmit.bind(this)}>
            { "Connect Facebook Account" }
          </Button>
      </span>
    )
  }

  render() {
    return (
      <LanderContainer>
        <ContainerInner>
          <header>
            <h1>Sign in</h1>
          </header>

          {
            this.props.facebookError !== "polis_err_user_with_this_email_exists" ?
              this.drawLoginForm() : this.drawPasswordConnectFacebookForm()
          }
        </ContainerInner>
      </LanderContainer>
    );
  }
}

export default SignIn;
