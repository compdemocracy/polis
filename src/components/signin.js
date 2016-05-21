import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../actions";
import Radium from "radium";
import Flex from "./framework/flex";
import Button from "./framework/generic-button";
import Awesome from "react-fontawesome";
import {Link} from "react-router";
import StaticContentContainer from "./framework/static-content-container";
import strings from "../strings/strings";

const styles = {
  heading: {
    fontSize: 36,
    display: "block",
    marginBottom: 20,
    marginTop: 0
  },
  card: {
    position: "relative",
    zIndex: 10,
    padding: 20,
    borderRadius: 3,
    color: "rgb(130,130,130)"
  },
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

  // componentDidMount() {
  //   window.addEventListener('resize', () => {}, true);
  // }

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
      <div>
        <form>
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
        </form>
        <p style={styles.termsSmallprint}>
          {
            "If you click 'Sign in with Facebook' and are not a pol.is user, you will be registered and you agree to the pol.is terms and privacy policy"
          }
        </p>
        <Button
          style={styles.facebookButton}
          onClick={this.facebookButtonClicked.bind(this)}>
          <Awesome style={{
            color: "#3b5998",
            backgroundColor: "rgb(255,255,255)",
            padding: "3px 5px",
            borderRadius: 3,
          }} name="facebook"/>
          <span style={{marginLeft: 10}}>{"Sign in with Facebook"}</span>
        </Button>

        <div style={styles.signupContainer}>
          {"Don't have an account? "}
          <Link style={styles.signupLink} to={"/createuser" + this.getDest()}>
            Sign up
          </Link>
        </div>
        <div style={styles.signupContainer}>
          {"Forgot your password? "}
          <Link style={styles.signupLink} to={"/pwresetinit"}>
            Reset Password
          </Link>
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
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}>
        <Flex>
          <div style={styles.card}>
            <p style={styles.heading}>
              <Awesome name={"sign-in"} /> Sign In
            </p>
            {
              this.props.facebookError !== "polis_err_user_with_this_email_exists" ?
                this.drawLoginForm() : this.drawPasswordConnectFacebookForm()
            }
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default SignIn;
