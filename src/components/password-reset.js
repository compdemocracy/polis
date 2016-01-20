import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doPasswordReset } from "../actions";
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

  handleClick(e) {
    e.preventDefault();
    const attrs = {
      newPassword: this.refs.password.value,
      pwresettoken: this.props.location.pathname.slice("/pwreset/".length),
    };

    if (attrs.newPassword !== this.refs.passwordRepeat.value) {
      alert ("Passwords need to match");
      return;
    }

    this.props.dispatch(doPasswordReset(attrs));
  }

  // componentDidMount() {
  //   window.addEventListener('resize', () => {}, true);
  // }

  render() {
    return (
      <StaticContentContainer>
        <Flex>
          <div style={styles.card}>
              <p style={styles.heading}><Awesome name="bolt" /> Password Reset</p>
            <form>
              <input
                style={styles.input}
                ref="password"
                placeholder="new password"
                type="password"/>
              <input
                style={styles.input}
                ref="passwordRepeat"
                placeholder="repeat new password"
                type="password"/>
              <Button style={styles.button} onClick={this.handleClick.bind(this)}>
                Set new password
              </Button>
            </form>
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default SignIn;
