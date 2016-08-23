import React from "react";
import Radium from "radium";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import StaticContentContainer from "../framework/static-content-container";
import strings from "../../strings/strings";

const styles = {
  container: {
    margin: 20,
    maxWidth: "31em"
  },
  heading: {
    fontSize: 36,
    fontWeight: 300,
    display: "block",
    marginBottom: 20,
    marginTop: 0,
    textAlign: "center"
  },
  bodyText: {
    fontWeight: 300,
    lineHeight: 1.8,
    letterSpacing: 1.15,
    fontFamily: "Georgia"
  },
  pic: {
    width: 150,
    borderRadius: 100
  }
};

@Radium
class Company extends React.Component {

  render() {
    return (
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}>
        <Flex styleOverrides={styles.container}>
          <div>
            <p style={[styles.heading, {marginTop: 30}]}>
              Company
            </p>
            <p style={styles.bodyText}>
              {"We’re a small, focused team of technologists trying to make the world a better place with surprisingly smart software. We love web, AI & OSS."}
            </p>
            <p style={[styles.heading, {marginTop: 50}]}>
              Founding Team
            </p>
            <Flex styleOverrides={{marginBottom: 30}} direction="column">
              <img style={styles.pic} src="https://pol.is/landerImages/18Ys8Byj.jpeg"/>
              <div>
              <p style={styles.bodyText}>
                Colin Megill
                <span style={{margin: "0px 8px"}}>•</span>
                CEO
                </p>
              </div>
              <a href="https://twitter.com/colinmegill">
                <Awesome style={{fontSize: 18, color: "#4099FF"}} name={"twitter"}/>
              </a>
            </Flex>
            <Flex styleOverrides={{marginBottom: 30}} direction="column">
              <img style={styles.pic} src="https://pol.is/landerImages/MItXxpoe.jpg"/>
              <div>
              <p style={styles.bodyText}>
                Michael Bjorkegren
                <span style={{margin: "0px 8px"}}>•</span>
                CTO
                </p>
              </div>
              <a href="https://twitter.com/mbjorkegren">
                <Awesome style={{fontSize: 18, color: "#4099FF"}} name={"twitter"}/>
              </a>
            </Flex>
            <Flex styleOverrides={{marginBottom: 30}} direction="column">
              <img style={styles.pic} src="https://pol.is/landerImages/th-BO255.jpeg"/>
              <div>
              <p style={styles.bodyText}>
                Christopher Small
                <span style={{margin: "0px 8px"}}>•</span>
                Lead Data Scientist
                </p>
              </div>
              <a href="https://twitter.com/metasoarous">
                <Awesome style={{fontSize: 18, color: "#4099FF"}} name={"twitter"}/>
              </a>
            </Flex>
            <p style={[styles.heading, {marginTop: 50}]}>
              Mission & Vision
            </p>
            <p style={styles.bodyText}>
              pol.is was conceived around the time of Occupy Wall Street and the Arab Spring.
              We felt if millions of people were going to show up to a conversation, the internet needed something that would scale up.
              We set out to build a communication system that would handle 'big' and stay coherent.
              We wanted people to feel safe & listened to, and we felt it was of the highest importance that minority opinions be preserved rather than 'outvoted'.

              <p style={styles.bodyText}> Most generally, we’re leveraging advances in mobile connectivity, artificial intelligence and machine learning to build tools that provide transparency, produce insight and decentralize power in all kinds of organizations of people everywhere on Earth. </p>
            </p>
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default Company;
