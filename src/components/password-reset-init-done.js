import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doPasswordResetInit } from "../actions";
import Radium from "radium";
import Flex from "./framework/flex";
import Button from "./framework/generic-button";
import Awesome from "react-fontawesome";
import StaticContentContainer from "./framework/static-content-container";

const styles = {
  heading: {
    fontSize: 24,
    display: "block",
    margin: 0
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
  awesome: {
    marginRight: 20
  }
}

@connect()
@Radium
class PasswordResetInitDone extends React.Component {

  render() {
    return (
      <StaticContentContainer>
        <Flex>
          <div style={styles.card}>
            <p style={styles.heading}>
              <Awesome style={styles.awesome} name="envelope"/>
                Check your email for a password reset link
            </p>
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default PasswordResetInitDone;
