// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { doCreateUser, doFacebookSignin } from "../../actions";
import { Heading, Box, Text } from "theme-ui";

import { Link } from "react-router-dom";
import StaticLayout from "./lander-layout";
import strings from "../../strings/strings";

@connect((state) => state.signin)
class Createuser extends React.Component {
  getDest() {
    return this.props.location.pathname.slice("/createuser".length);
  }

  handleLoginClicked(e) {
    e.preventDefault();
    const attrs = {
      hname: this.refs.hname.value,
      email: this.refs.email.value,
      password: this.refs.password.value,
      gatekeeperTosPrivacy: true,
    };

    var dest = this.getDest();
    if (!dest.length) {
      dest = "/";
    }
    this.props.dispatch(doCreateUser(attrs, dest));
  }

  facebookButtonClicked() {
    var dest = this.getDest();
    if (!dest.length) {
      dest = "/";
    }
    this.props.dispatch(doFacebookSignin(dest));
  }

  handleFacebookPasswordSubmit() {
    var dest = this.getDest();
    if (!dest.length) {
      dest = "/";
    }
    const optionalPassword = this.refs.facebook_password.value;
    this.props.dispatch(doFacebookSignin(dest, optionalPassword));
  }
  maybeErrorMessage() {
    let markup = "";
    if (this.props.error) {
      markup = <div>{strings(this.props.error.responseText)}</div>;
    }
    return markup;
  }
  drawForm() {
    return (
      <div>
        <form>
          <input ref="hname" placeholder="name" type="text" />
          <input ref="email" placeholder="email" type="email" />
          <input ref="password" placeholder="password" type="password" />
          <input ref="password2" placeholder="repeat password" type="password" />

          {this.maybeErrorMessage()}

          <div>
            <p>
              {"I agree to the "}
              <a href="https://pol.is/tos" tabIndex="110">
                pol.is terms
              </a>{" "}
              and{" "}
              <a href="https://pol.is/privacy" tabIndex="111">
                {" "}
                privacy agreement
              </a>
              .
            </p>
          </div>

          <button onClick={this.handleLoginClicked.bind(this)}>
            {this.props.pending ? "Creating Account..." : "Create Account"}
          </button>
        </form>
        <p>
          If you click 'Sign in with Facebook' and are not a pol.is user, you will be registered and
          you agree to the pol.is terms and privacy policy
        </p>
        <button onClick={this.facebookButtonClicked.bind(this)}>
          <span>{"Sign up with Facebook"}</span>
        </button>

        <div>
          {"Already have an account? "}
          <Link tabIndex="6" to={"/signin" + this.getDest()} data-section="signup-select">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  drawPasswordConnectFacebookForm() {
    return (
      <span>
        <p>
          {
            "A pol.is user already exists with the email address associated with this Facebook account."
          }
        </p>
        <p>{"Please enter the password to your pol.is account to enable Facebook login."}</p>
        <input ref="facebook_password" placeholder="polis password" type="password" />
        <button onClick={this.handleFacebookPasswordSubmit.bind(this)}>
          {"Connect Facebook Account"}
        </button>
      </span>
    );
  }

  render() {
    return (
      <StaticLayout>
        <div>
          <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
            Create Account
          </Heading>
          {this.props.facebookError !== "polis_err_user_with_this_email_exists"
            ? this.drawForm()
            : this.drawPasswordConnectFacebookForm()}
        </div>
      </StaticLayout>
    );
  }
}

export default Createuser;
