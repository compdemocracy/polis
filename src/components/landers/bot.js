import Awesome from "react-fontawesome";
import BackgroundStars from "../framework/background-stars";
import Button from "../framework/generic-button";
import Flex from "../framework/flex";
import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../../actions";
import { browserHistory } from "react-router";
import Radium from "radium";
import StaticContentContainer from "../framework/static-content-container";
import Press from "./press";
import Step from "./step";

// import { Tweet } from 'react-twitter-widgets';

/*

  <p> polis leverages techniques from both quantitative and qualitative research, combined with powerful analytics, to gather feedback that is simultaneously authentic to the population being surveyed and data rich. </p>

*/

@connect()
@Radium
class Plus extends React.Component {
  styles() {
    return {
      container: {
        minWidth: "100vw",
        zIndex: 10
      },
      sectionColor: {
        minWidth: "100vw",
        backgroundColor: "#03a9f4",
        color: "white",
      },
      hero: {
        fontSize: "2.5em",
        lineHeight: 1.4,
        maxWidth: 900,
        padding: "0px 40px",
        zIndex: 10,
        textAlign: 'center',
      },
      heroSub: {
        fontSize: 24,
        lineHeight: 1.6,
        textAlign: 'center',
        fontWeight: 300,
        margin: 0,
        padding: "0px 40px",
        maxWidth: 700,
        zIndex: 10,
      },
      waitingListInput: {
        padding: 13,
        backgroundColor: "rgb(240,240,240)",
        border: "none",
        borderRadius: 3,
        margin: "20px 0px 10px 0px"

      },
      waitingListButton: {
        backgroundColor: "#03a9f4",
        color: "white",
        borderRadius: 3,
        margin: "0px 0px 20px 0px"
      },
      slackContainer: {
        marginBottom: 40,
        marginTop: 0,
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
        padding: "30px 0px"
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
        backgroundColor: "rgb(245,245,245)"
      },
      pricingHeadline: {
        color: "rgb(130,130,130)",
        fontWeight: 700,
        fontSize: "1.2em",
        textTransform: "uppercase"
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
        margin: "10px 20px 40px 20px",
        textAlign: "center",
        lineHeight: 1.8,

      },
    }
  }
  handleJoinWaitingListClicked(r) {
    // todo
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
          direction="column"
          alignItems="center"
          >
            <p style={this.styles().hero}>
              {`
                Ask questions of your people, get
                sophisticated summaries of their thoughts. Automatically.
              `}
            </p>
            <p style={this.styles().heroSub}>
              Meet PolisBot, an AI powered slackbot. Eliminate
               information gathering meetings, complex
              email chains and time spent creating surveys. Ask the questions
              that come naturally to groups of any size.
            </p>
        </Flex>
        {/* upper cta */}
        <div>
          <input
            placeholder="email"
            style={this.styles().waitingListInput}
            type="email"/>
        </div>
        <div>
          <Button
            onClick={this.handleJoinWaitingListClicked()}
            style={this.styles().waitingListButton}> Join the Waiting List </Button>
        </div>
        <div style={this.styles().slackContainer}>
          <img src="http://s33.postimg.org/zfoqfil0v/slack_Interface.png" />
        </div>
        <Flex
          styleOverrides={{
            width: "100%",

          }}
          direction="column"
          justifyContent="center"
          wrap="nowrap"
          alignItems="center">
          <p style={this.styles().howItWorks}> How PolisBot works </p>
          <Step
            step={"1"}
            body={`
              Invite PolisBot to your Slack team
              `}/>
          <Step
            step={"2"}
            body={`
              Tell PolisBot what you want to know about and specify some combination of
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
              PolisBot sends you a summary of statements that enjoyed broad consensus. If there were divisive issues, the summary will also convey opinion groups that formed, whether they were the majority or minority, and what issues separated them from the rest of the participants.
              `}/>
        </Flex>
        <Flex
          styleOverrides={this.styles().pricingContainer}
          direction="column"
          justifyContent="center">
          <p style={this.styles().pricingHeadline}> Transparent Pricing </p>
          <p style={this.styles().pricingDesc}> 45 days to experiment. $3 / month / user thereafter. </p>
          <p style={this.styles().pricingNumber}> $3 </p>
          <p style={this.styles().pricingSubtext}> per month per slack user </p>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default Plus;
