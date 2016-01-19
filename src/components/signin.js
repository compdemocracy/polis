import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin } from "../actions";
import Radium from "radium";
import Flex from "./framework/flex";
import Button from "./framework/generic-button";
import BackgroundStars from "./framework/background-stars";
import Awesome from "react-fontawesome";


const styles = {
  topBar: {
    width: "100%",
    fontSize: 24,
    fontWeight: 700,
    color: "white",
    backgroundColor: "rgba(0,0,0,.3)",
    position: "relative",
    zIndex: 10,
  },
  footer: {
    width: "100%",
    backgroundColor: "rgba(0,0,0,.3)",
    color: "white",
    position: "relative",
    zIndex: 10,
  },
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
  flexContainer: {
    height: "100vh",
    background: "url(https://pol.is/landerImages/billions-compressor.jpeg) no-repeat center center fixed",
    backgroundSize: "cover",
  },
  button: {
    display: "block",
    margin: "10px 0px"
  },
  input: {
    display: "block",
    margin: "10px 0px",
    color: "rgb(100,100,100)",
    fontSize: 14,
    padding: 7,
    borderRadius: 3,
    border: "1px solid rgba(240,240,240,1)",
  }
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
      <div style={styles.flexContainer}>
        <Flex direction="column" justifyContent="space-between" styleOverrides={{height: "100%"}}>
          <div style={styles.topBar}>
            <Flex>
              <p>POLIS</p>
            </Flex>
          </div>
          <Flex >
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
          <Flex styleOverrides={styles.footer}>
            <p> Footer </p>
          </Flex>
        </Flex>
        <BackgroundStars/>
      </div>
    );
  }
}

export default SignIn;
