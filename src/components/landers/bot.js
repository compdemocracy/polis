import Awesome from "react-fontawesome";
import BackgroundStars from "../framework/background-stars";
import Button from "../framework/generic-button";
import Flex from "../framework/flex";
import InputField from "material-ui/lib/text-field";
import PolisLogo from "../framework/polis-logo";
import PolisNet from "../../util/net";
import Press from "./press";
import Radium from "radium";
import React from "react";
import StaticContentContainer from "../framework/static-content-container";
import Step from "./step";
import strings from "../../strings/strings";
import { browserHistory } from "react-router";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../../actions";
import HexLogoLargeShort from "../framework/hex-logo-large-short";


// import { Tweet } from 'react-twitter-widgets';

/*

  <p> polis leverages techniques from both quantitative and qualitative research, combined with powerful analytics, to gather feedback that is simultaneously authentic to the population being surveyed and data rich. </p>

*/

let defaultState = {
  successTextUpper: "",
  successTextLower: "",
  errorTextUpper: "",
  errorTextLower: "",
};


@connect()
@Radium
class Bot extends React.Component {
  styles() {
    return {
      container: {
        width: "100%",
        zIndex: 10
      },
      error: {
        color: "red",
        margin: "0px 0px 0px 20px",
      },
      success: {
        margin: "0px 0px 0px 20px",
      },
      sectionColor: {
        width: "100%",
        backgroundColor: "#03a9f4",
        color: "white",
      },
      heroContainer: {
        width: "100%",
        paddingTop: 20,
        backgroundColor: "rgb(245,245,245)"
      },
      hero: {
        fontSize: "2.5em",
        lineHeight: 1.4,
        marginBottom: 10,
        marginTop: 10,
        maxWidth: 900,
        padding: "0px 40px",
        zIndex: 10,
        textAlign: 'center',
        width: "100%",
        color: "rgb(130,130,130)",
      },
      heroSub: {
        fontSize: 24,
        color: "rgb(130,130,130)",
        lineHeight: 1.6,
        textAlign: 'center',
        fontWeight: 300,
        margin: "10px 0px 0px 0px",
        padding: "0px 40px 40px 40px",
        maxWidth: 700,
        zIndex: 10,
      },
      slackLogo: {
        width: 25,
        marginRight: 2,
        marginLeft: 0,
        position: "relative",
        top: 4
      },
      waitingListInput: {
        padding: 16,
        border: "none",
        borderRadius: 3,
        margin: "20px 0px 10px 0px",
        '@media (min-width: 470px)': {
          marginRight: 20,
        },
      },
      waitingListButton: {
        backgroundColor: "#03a9f4",
        color: "white",
        borderRadius: 3,
        margin: "0px 0px 20px 0px"
      },
      imageContainer: {
        width: "100%",
        marginBottom: 40,
        marginTop: 0,
        position: "relative",
        '@media (min-width: 768px)': {
          marginTop: 40
        },
      },
      interfaceImage: {
        width: "100%",
        zIndex: -1000,
        '@media (min-width: 320px)': {
          marginTop: 0,
          width: "90%"
        },
        '@media (min-width: 768px)': {
          display: "none"
        }
      },
      conversationImage: {
        '@media (min-width: 320px)': {
          width: '90%',
          position: "inherit"
        },
        '@media (min-width: 768px)': {
          display: "none"
        },
      },
      imagesCombinedForHighRes: {
        display: "none",
        '@media (min-width: 768px)': {
          display: "inherit",
          width: 800,
        },
      },
      body: {
        padding: 40
      },
      section: {
        padding: 0,
      },
      howItWorks: {
        fontSize: "2em",
        color: "rgb(130,130,130)"
      },
      bandSection: {
        backgroundColor: "#03a9f4",
        color: "white",
        width: "100vw",
        padding: "30px 0px",
      },
      sectionHeader: {
        fontSize: 24,
        marginBottom: 0,
      },
      sectionBody: {
        maxWidth: 500,
        fontWeight: 300,
        lineHeight: 1.5
      },
      button: {
        backgroundColor: "white",
        color: "rgb(100,100,100)"
      },
      flexTestContainer: {
        minHeight: "100%"
      },
      flexTestDiv: {
        backgroundColor: "red",
        color: "white",
        minHeight: 50,
        width: "100%",
      },
      pricingContainer: {
        margin: "20px 0px 0px 0px",
        width: "100%",
        backgroundColor: "rgb(245,245,245)",
        paddingTop: 20
      },
      pricingHeadline: {
        color: "rgb(130,130,130)",
        fontWeight: 700,
        fontSize: "1.2em",
        textTransform: "uppercase",
        paddingTop: 20,
      },
      pricingDesc: {
        color: "rgb(130,130,130)",
        fontWeight: 300,
        fontSize: "1.7em",
        textAlign: "center",
        lineHeight: 1.8,
        margin: 20,
      },
      pricingNumber: {
        color: "rgb(130,130,130)",
        fontSize: "5em",
        margin: 0,
      },
      pricingSubtext: {
        color: "rgb(130,130,130)",
        fontSize: "1.4em",
        margin: "10px 20px 10px 20px",
        textAlign: "center",
        lineHeight: 1.8,

      },
      callToActionContainer: {
        width: "100%",
        backgroundColor: "rgb(245,245,245)",
        paddingBottom: 20,
      }
    }
  }
  handleJoinWaitingListClickedUpper() {
    this.doHandleJoinWaitingListClicked(this.refs.emailupper && this.refs.emailupper.value).then(() => {
      this.setState(Object.assign({}, defaultState, {
        successTextUpper: strings("waitinglist_add_success"),
      }));
    }, (err) => {
      this.setState(Object.assign({}, defaultState, {
        errorTextUpper: err.responseText,
      }));
    });
  }
  handleJoinWaitingListClickedLower() {
    this.doHandleJoinWaitingListClicked(this.refs.emaillower && this.refs.emaillower.value).then(() => {
      this.setState(Object.assign({}, defaultState, {
        successTextLower: strings("waitinglist_add_success"),
      }));
    }, (err) => {
      this.setState(Object.assign({}, defaultState, {
        errorTextLower: err.responseText,
      }));
    });
  }
  doHandleJoinWaitingListClicked(email) {
    const data = {
      campaign: "bot",
      email: email,
    };
    return PolisNet.polisPost("/api/v3/waitinglist", data);
  }
  render() {
    return (
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}
        stars={{visible: true, color: "darkgrey"}}>
        {/* hero */}
        <Flex
          styleOverrides={this.styles().heroContainer}
          direction="column"
          alignItems="center"
          >
          <Flex>
          {/*
            <PolisLogo color={"rgb(130,130,130)"} backgroundColor={"rgb(130,130,130)"}/>
            <Awesome style={{color: "rgb(130,130,130)"}} name={"heart"}/>
          */}
          <HexLogoLargeShort/>
          </Flex>
            <p style={this.styles().hero}>
              {`
                Your team's thoughts. Automatically.
              `}
            </p>

            <p style={this.styles().heroSub}>
              Meet PolisBot, an AI powered <img
               style={this.styles().slackLogo}
               src="https://upload.wikimedia.org/wikipedia/en/7/76/Slack_Icon.png"/>Slack bot. Ask the questions you
              have, get sophisticated text summaries automatically. Eliminate
               information gathering meetings, complex
              email chains and time spent creating surveys. Works with
              teams of any size - even thousands.
            </p>


        </Flex>
        {/* upper cta */}
        <Flex
          direction="column"
          styleOverrides={this.styles().callToActionContainer}>
        <Flex alignItems="baseline" wrap="wrap">
          <input
            placeholder="email"
            style={this.styles().waitingListInput}
            ref="emailupper"
            type="email"/>
          <Button
            onClick={this.handleJoinWaitingListClickedUpper.bind(this)}
            style={this.styles().waitingListButton}>
            Join the Waiting List
          </Button>

          {this.maybeErrorMessage(this.state.errorTextUpper)}
          {this.maybeSuccessMessage(this.state.successTextUpper)}

        </Flex>
        </Flex>
        <Flex
          direction="column"
          styleOverrides={this.styles().imageContainer}>
          <img
            style={this.styles().imagesCombinedForHighRes}
            src="http://s32.postimg.org/qdigc9kvp/convo_Interface_Combined.png"/>
          <img
            style={this.styles().interfaceImage}
            src="http://s33.postimg.org/zfoqfil0v/slack_Interface.png"/>
          <img
            style={this.styles().conversationImage}
            src="http://s33.postimg.org/jr40v6nov/conversation.png"/>
        </Flex>
        <Flex
          styleOverrides={{
            width: "100%",

          }}
          direction="column"
          justifyContent="center"
          wrap="nowrap"
          alignItems="center">
          <p style={this.styles().howItWorks}> Get started in minutes </p>
          <Step
            step={"1"}
            body={`
              Invite PolisBot to your Slack team (we'll send you a link when your turn comes up on the wait list)
              `}/>
          <Step
            step={"2"}
            body={`
              Send PolisBot a question to ask your team and specify some combination of
              #channels and @users to participate
              `}/>
          <Step
            step={"3"}
            body={`
              Assign someone (or yourself) to moderate statements for workplace appropriateness
              `}/>
          <Step
            step={"4"}
            body={`
              PolisBot sends you a summary of statements that enjoyed broad consensus.
              If there were divisive issues,
              the summary will also convey opinion groups that formed,
              whether they were the majority or minority,
              and what issues separated them from the rest of the participants
              `}/>
        </Flex>

        <Flex
          styleOverrides={this.styles().pricingContainer}
          direction="column"
          justifyContent="center">
          <HexLogoLargeShort/>

          <p style={this.styles().pricingDesc}> 45 days to experiment, completely free.</p>
        </Flex>
        {/* lower cta */}
        <Flex
          direction="column"
          styleOverrides={this.styles().callToActionContainer}>
        <Flex wrap="wrap" alignItems="baseline">
          <input
            placeholder="email"
            style={this.styles().waitingListInput}
            ref="emaillower"
            type="email"/>
          <Button
            onClick={this.handleJoinWaitingListClickedLower.bind(this)}
            style={this.styles().waitingListButton}>
            Join the Waiting List
          </Button>

          {this.maybeErrorMessage(this.state.errorTextLower)}
          {this.maybeSuccessMessage(this.state.successTextLower)}

        </Flex>
        </Flex>
      </StaticContentContainer>
    );
  }
  maybeErrorMessage(text) {
    let markup = "";
    if (text) {
      markup = (
        <div style={this.styles().error}>
          { strings(text) }
        </div>
      );
    }
    return markup;
  }
  maybeSuccessMessage(text) {
    let markup = "";
    if (text) {
      markup = (
        <div style={this.styles().success}>
          { strings(text) }
        </div>
      );
    }
    return markup;
  }
}

export default Bot;
