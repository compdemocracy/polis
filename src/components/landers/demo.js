// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../../actions";
import { browserHistory } from "react-router";
import Radium from "radium";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import StaticContentContainer from "../framework/static-content-container";
import Press from "./press";
import Step from "./step";
import BackgroundStars from "../framework/background-stars";
import PolisLogo from "../framework/polis-logo";

@connect()
@Radium
class Demo extends React.Component {
  styles() {
    return {
      container: {
        width: "100%",
        zIndex: 10
      },
      sectionColor: {
        width: "100%",
        backgroundColor: "#03a9f4",
        color: "white",
      },
      heroContainer: {
        width: "100%",
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
        width: 100,
        marginTop: 20,
      },
      waitingListInput: {
        padding: 13,
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
      lowerCallToActionContainer: {
        width: "100%",
        backgroundColor: "rgb(230,230,230)",
      }
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
        <div className='polis' data-conversation_id='2arcefpshi'></div>
        <script async src='https://pol.is/embed.js'></script>
      </StaticContentContainer>
    );
  }
}

export default Demo;
