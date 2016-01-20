import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin } from "../actions";
import Radium from "radium";
import Flex from "./framework/flex";
import Button from "./framework/generic-button";
import Awesome from "react-fontawesome";
import StaticContentContainer from "./framework/static-content-container";

const styles = {
  heading: {
    fontSize: 36,
    display: "block",
    marginBottom: 20
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
}

@connect()
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

  render() {
    return (
      <StaticContentContainer>
        <Flex>
          <div style={styles.card}>
              <p style={styles.heading}><Awesome name="sign-in" /> Sign In</p>
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
            <p style={{fontFamily: "Serif", fontSize: 12, maxWidth: 400, fontWeight: 100}}>
              If you click "Log in with Facebook" and are not a pol.is user, you will be registered and you agree to the pol.is terms and privacy policy
            </p>
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default SignIn;
