// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
import PublishersFlat from "../framework/publishersFlat";
import Meditator from "../framework/meditator";
import Elephant from "../framework/elephant";
import UpAndToTheRight from "../framework/upAndToTheRight";
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
class News2 extends React.Component {
  styles() {
    return {
      container: {
        width: "100%",
        zIndex: 10
      },
      error: {
        color: "red",
      },
      success: {
      },
      callToActionContainer: {
        width: "100%",
        backgroundColor: "rgb(245,245,245)",
        paddingBottom: 20,
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
        zIndex: 10,
        textAlign: "center",
        width: "100%",
        color: "rgb(130,130,130)",
      },
      heroSub: {
        fontSize: 24,
        color: "rgb(130,130,130)",
        lineHeight: 1.6,
        textAlign: "center",
        fontWeight: 300,
        maxWidth: 700,
        zIndex: 10,
      },
      waitingListInput: {
        padding: 16,
        border: "none",
        borderRadius: 3,
        margin: "20px 0px 10px 0px",
        "@media (min-width: 470px)": {
          marginRight: 20,
        },
      },
      waitingListButton: {
        backgroundColor: "#03a9f4",
        color: "white",
        borderRadius: 3,
        margin: "0px 0px 20px 0px"
      },
      body: {
        padding: 40
      },
      section: {
        padding: 0,
      },
      caseStudyTextContainer: {
        /* WHEN IT'S SMALL AND UP (DEFAULT) */
        maxWidth: 320,
        marginLeft: 0,
        /* WHEN IT'S BIG */
        "@media (min-width: 768px)": {
          marginLeft: 50,
        },
      },
      goSection: {
        /* WHEN IT'S SMALL AND UP (DEFAULT) */
        width: "100%",
        display: "flex",
        textDecoration: "none",
        paddingBottom: 20,
        opacity: "0.95",
        ':hover': {
          opacity: "1",
        },
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        // '@media (min-width: 320px)': {
        //   marginTop: 0,
        //   width: "90%"
        // },
        /* WHEN IT'S BIG */
        "@media (min-width: 768px)": {
          flexDirection: "row",
          minHeight: 200
        }
      },
      cloud: {
        backgroundColor: "rgb(240,240,240)",
      },
      oss: {
        backgroundColor: "rgb(230,230,230)",
      },
      export: {
        backgroundColor: "rgb(240,240,240)",
      },
      icon: {
        color: "white",
        fontSize: "4em",
        borderRadius: 100,
        backgroundColor: "#FF613C",
        width: 110,
        height: 110,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      },
      iconWrapper: {
        marginTop: 20,

        "@media (min-width: 768px)": {
          marginLeft: 30,
          width: 250,
        }
      },
      button: {
        backgroundColor: "white",
        color: "rgb(100,100,100)"
      },
      forText: {
        color: "rgb(130,130,130)",
        width: "100%",
        fontSize: "1.5em",
        lineHeight: "1.7",
        fontWeight: 300,
        textAlign: "center",
        "@media (min-width: 768px)": {
          textAlign: "left",
          width: "50%",
        }
      },
      howItWorksText: {
        color: "rgb(130,130,130)",
        width: "100%",
        fontSize: "1.5em",
        lineHeight: "1.7",
        fontWeight: 300,
        "@media (min-width: 768px)": {
          textAlign: "center",
          width: "50%",
        }
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
      campaign: "gov",
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
                Rich online discourse to stimulate and engage your audience
              `}
            </p>

            <p style={this.styles().heroSub}>
              pol.is is an embeddable discussion platform that engages more of your readers in meaningful conversation, with less burden on you.
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
              Request a Demo
            </Button>
            {this.maybeErrorMessage(this.state.errorTextUpper)}
            {this.maybeSuccessMessage(this.state.successTextUpper)}
          </Flex>
        </Flex>


        <div style={{width: "100%", backgroundColor: "rgb(224,224,224)"}}>
          <div
            key="1"
            style={[this.styles().goSection]}
            >
            <div style={this.styles().iconWrapper}>
              <Meditator/>
            </div>
            <p style={this.styles().forText}> Welcome to a world beyond trolling and fights. Conversations are self regulating, and elevate community managers to powerful content curators. </p>
          </div>
        </div>
        <div style={{width: "100%", backgroundColor: "rgb(242,242,242)"}}>
          <div
            key="2"
            style={[this.styles().goSection]}
            >
            <div style={this.styles().iconWrapper}>
              <Elephant/>
            </div>
            <p style={this.styles().forText}> pol.is uses AI to solve the underlying problems with scaling community discussions, and gets better as more people participate. </p>
          </div>
        </div>
        <div style={{width: "100%", backgroundColor: "rgb(224,224,224)"}}>
          <div
            key="3"
            style={[this.styles().goSection]}
            >
            <div style={this.styles().iconWrapper}>
              <UpAndToTheRight/>
            </div>
            <p style={this.styles().forText}> Users like you are seeing 10x increases in user engagement over commenting. </p>
          </div>
        </div>
        <div style={{
            width: "100%",
            display: "flex",
            marginTop: 20,
            marginBottom: 20,
            alignItems: "center",
            flexDirection: "column",
            justifyContent: "center",
          }}>
          <p style={this.styles().hero}>
            How it works
          </p>
          <p style={this.styles().howItWorksText}> Get up and running in minutes by dropping a script tag onto your site. pol.is works in addition to, or as a replacement for, your existing commenting system. </p>
          <p style={this.styles().howItWorksText}> Users write and vote. pol.is crunches that data and produces opinion groups. All users can see where they stand relative to others in an interactive visualization that shows majority, minority and consensus. </p>
        </div>
        <div style={{width: "100%", backgroundColor: "rgb(242,242,242)"}}>
          <div
            key="5"
            style={[this.styles().goSection]}
            >
            <div style={this.styles().iconWrapper}>
              <img width="200" src="http://orig07.deviantart.net/5590/f/2013/125/d/5/homemade_verified_twitter_icon_by_etschannel-d645upi.png"/>
            </div>
            <p style={this.styles().forText}> Engage your brightest, busiest readers. You’ll immediately see a whole new demographic of user engaging in and returning to discussions around your content.</p>
          </div>
        </div>

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

export default News2;
