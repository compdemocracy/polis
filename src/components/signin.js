import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../actions";
import Radium from "radium";
import Flex from "./framework/flex";
import Button from "./framework/generic-button";
import Awesome from "react-fontawesome";
import StaticContentContainer from "./framework/static-content-container";

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
    backgroundColor: "rgba(0,0,0,.3)",
    padding: "50px",
    borderRadius: 3,
    color: "white"
  },
  button: {
    display: "block",
    backgroundColor: "white",
    color: "rgb(100,100,100)"
  },
  input: {
    display: "block",
    margin: "10px 0px",
    color: "rgb(100,100,100)",
    fontSize: 14,
    padding: 7,
    borderRadius: 3,
    border: "1px solid rgba(240,240,240,1)",
  },
  facebookButton: {
    border: 0,
    color: "white",
    backgroundColor: "#3b5998",
    fontWeight: 300,
    padding: "8px 12px",
    borderRadius: 5,
    fontSize: 14,
  }
}

@connect(state => state.signin)
@Radium
class SignIn extends React.Component {

  handleLoginClicked(e) {
    e.preventDefault();
    const attrs = {
      email: this.refs.email.value,
      password: this.refs.password.value
    }

    var dest = this.props.location.pathname.slice("/signin".length);

    this.props.dispatch(doSignin(attrs, dest));
  }

  // componentDidMount() {
  //   window.addEventListener('resize', () => {}, true);
  // }

  facebookButtonClicked() {
    var dest = this.props.location.pathname.slice("/signin".length);
    this.props.dispatch(doFacebookSignin(dest))
  }

  handleFacebookPasswordSubmit() {
    var dest = this.props.location.pathname.slice("/signin".length);
    const optionalPassword = this.refs.facebook_password.value
    this.props.dispatch(doFacebookSignin(dest, optionalPassword))
  }

  render() {
    return (
      <StaticContentContainer>
        <Flex>
          <div style={styles.card}>
            <p style={styles.heading}>
              <Awesome name={"sign-in"} /> Sign In
            </p>
            {
              this.props.facebookError !== "polis_err_user_with_this_email_exists" ?
              <div>
                <form>
                  <input
                    style={styles.input}
                    ref="email"
                    placeholder="email"
                    type="text"/>
                  <input
                    style={styles.input}
                    ref="password"
                    placeholder="password"
                    type="password"/>
                  <Button style={styles.button} onClick={this.handleLoginClicked.bind(this)}>
                    Sign In
                  </Button>
                </form>
                <p
                  style={{
                    fontSize: 12,
                    maxWidth: 400,
                    fontWeight: 100
                  }}>
                  {
                    "If you click 'Log in with Facebook' and are not a pol.is user, you will be registered and you agree to the pol.is terms and privacy policy"
                  }
                </p>
                <Button style={styles.facebookButton} onClick={this.facebookButtonClicked.bind(this)}>
                  <Awesome style={{
                    color: "#3b5998",
                    backgroundColor: "white",
                    padding: "3px 5px",
                    borderRadius: 3,
                  }} name="facebook"/>
                  <span style={{marginLeft: 10}}>{"Sign in with Facebook"}</span>
                </Button>
              </div> :

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
            }
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default SignIn;
