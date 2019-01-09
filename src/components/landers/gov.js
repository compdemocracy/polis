// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
class Gov extends React.Component {
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
      callToActionInnerFlex: {

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
        margin: "0px 0px 10px 0px",
        "@media (min-width: 470px)": {
          marginRight: 20,
        },
      },
      waitingListButton: {
        backgroundColor: "#03a9f4",
        color: "white",
        borderRadius: 3,
        // margin: "0px 0px 20px 0px"
      },
      body: {
        padding: 40
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
      section: {
        /* WHEN IT'S SMALL AND UP (DEFAULT) */
        width: "100%",
        display: "flex",
        textDecoration: "none",
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
      videoSectionTitle: {
        color: "white",
        fontSize: 36
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
    }
  }
  handleJoinWaitingListClickedUpper() {
    this.doHandleJoinWaitingListClicked({
      email: this.refs.emailupper && this.refs.emailupper.value,
      name: this.refs.nameupper && this.refs.nameupper.value,
      affiliation: this.refs.affiliationupper && this.refs.affiliationupper.value,
      role: this.refs.roleupper && this.refs.roleupper.value,
    }).then(() => {
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
    this.doHandleJoinWaitingListClicked({
      email: this.refs.emaillower && this.refs.emaillower.value,
      name: this.refs.namelower && this.refs.namelower.value,
      affiliation: this.refs.affiliationlower && this.refs.affiliationlower.value,
      role: this.refs.rolelower && this.refs.rolelower.value,
    }).then(() => {
      this.setState(Object.assign({}, defaultState, {
        successTextLower: strings("waitinglist_add_success"),
      }));
    }, (err) => {
      this.setState(Object.assign({}, defaultState, {
        errorTextLower: err.responseText,
      }));
    });
  }
  doHandleJoinWaitingListClicked(data) {
    data.campaign = "gov";
    return PolisNet.polisPost("/api/v3/waitinglist", data);
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
                Democracy, Meet AI
              `}
            </p>

            <p style={this.styles().heroSub}>
              pol.is is bringing AI & machine learning to participatory democracy. Scale up outreach in online consultation & get powerful insights that can shape and legitimize policy.
            </p>
        </Flex>
        {/* upper cta */}
        <Flex
          alignItems="center"
          styleOverrides={this.styles().callToActionContainer}>
          <Flex
            styleOverrides={this.styles().callToActionInnerFlex}
            direction="column"
            alignItems="flex-start">
            <input
              placeholder="Name"
              style={this.styles().waitingListInput}
              ref="nameupper"
              type="name"/>
            <input
              placeholder="Email"
              style={this.styles().waitingListInput}
              ref="emailupper"
              type="email"/>
            <input
              placeholder="Organization"
              style={this.styles().waitingListInput}
              ref="affiliationupper"
              type="affiliation"/>
            <input
              placeholder="Role"
              style={this.styles().waitingListInput}
              ref="roleupper"
              type="role"/>
            <Button
              onClick={this.handleJoinWaitingListClickedUpper.bind(this)}
              style={this.styles().waitingListButton}>
              Contact Me
            </Button>
          <div style={{margin: 10}}>
            {this.maybeErrorMessage(this.state.errorTextUpper)}
            {this.maybeSuccessMessage(this.state.successTextUpper)}
          </div>
        </Flex>
        </Flex>
        <div
          style={{
            width: "100%",
            display: "block",
            backgroundColor: "#03a9f4",
            padding: "0px 0px 30px 0px"
          }}>
          <Flex>
          <p style={[this.styles().videoSectionTitle]}> A Brief Introduction </p>
          </Flex>
          <Flex>
          <iframe
            width="640"
            height="360"
            style={{border: "10px solid white", borderRadius: 4, margin: "auto"}}
            src="https://www.youtube.com/embed/09Lqj5lazKM?rel=0&amp;showinfo=0"
            frameborder="0"
            allowfullscreen>
          </iframe>
          </Flex>
        </div>
        <Flex styleOverrides={{width: "100%"}} direction="column">
          <p style={{
            fontFamily: "Georgia",
            fontSize: 36,
            color: "rgb(130,130,130)",
          }}> Taiwan: A Case Study </p>
          <Flex
            styleOverrides={{width: "100%", marginBottom: 0}}
            justifyContent="center"
            wrap="wrap"
            alignItems="baseline">
            <Flex direction="column">
              <blockquote className="twitter-tweet" dataLang="en"><p lang="en" dir="ltr"><a href="https://twitter.com/UsePolis">@UsePolis</a> increased citizen engagement around policy proposals from 10&#39;s of people to 1000&#39;s, and increased quality as well.</p>&mdash; 唐鳳 (@audreyt) <a href="https://twitter.com/audreyt/status/744450181307850752">June 19, 2016</a></blockquote>
              <blockquote className="twitter-tweet" data-lang="en"><p lang="en" dir="ltr">You need to read about vTaiwan, it&#39;s the future of <a href="https://twitter.com/hashtag/democracy?src=hash">#democracy</a>, today. Seriously. Read. It. Now. <a href="https://t.co/4BheYqw9vx">{"https://t.co/4BheYqw9vx"}</a></p>&mdash; United Diversity (@uniteddiversity) <a href="https://twitter.com/uniteddiversity/status/767656559434469376">August 22, 2016</a></blockquote>
            </Flex>
            <Flex
              direction="column"
              alignItems="flex-start"
              styleOverrides={this.styles().caseStudyTextContainer}>
              <p style={{
                fontFamily: "Georgia",
                fontSize: 24,
                letterSpacing: "1.4",
                color: "rgb(130,130,130)",
              }}> Crowdsourcing Legislation </p>

              <p style={{
                fontFamily: "Georgia",
                fontSize: 16,
                lineHeight: 1.6,
                color: "rgb(130,130,130)",
              }}> The national government of Taiwan, working alongside civic minded  technologists, is using pol.is to improve the relationship between the people and the government, involving citizens more deeply in the policy formation process. </p>
              <Flex styleOverrides={{width: "100%", marginTop: 20, marginBottom: 30}} justifyContent="center">
                <svg width="65px" height="5px" viewBox="0 0 65 5">
                  <g id="Page-1" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
                    <g id="Desktop-HD-Copy-2" transform="translate(-975.000000, -1073.000000)" fill="#D8D8D8">
                      <g id="Group" transform="translate(975.000000, 1073.000000)">
                        <circle id="Oval-3" cx="2.5" cy="2.5" r="2.5"></circle>
                        <circle id="Oval-3" cx="32.5" cy="2.5" r="2.5"></circle>
                        <circle id="Oval-3" cx="62.5" cy="2.5" r="2.5"></circle>
                      </g>
                    </g>
                  </g>
                </svg>
              </Flex>
              <Flex styleOverrides={{width: "100%"}} justifyContent="space-between" alignItems="center">
                <a
                  style={{
                    fontFamily: "Georgia",
                    fontSize: 16,
                    width: 300,
                    lineHeight: 1.6,
                    color: "rgb(130,130,130)",
                  }}
                  href="http://www.lemonde.fr/idees/article/2016/05/25/une-experience-pionniere-de-democratie-numerique-a-taiwan_4926104_3232.html">
                  "A Pioneering Experience of Digital Democracy in Taiwan"
                </a>
                <img height="32" src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/43/Le_Monde.svg/2000px-Le_Monde.svg.png"/>
              </Flex>
              <Flex styleOverrides={{width: "100%", marginTop: 30, marginBottom: 20}} justifyContent="center">
                <svg width="65px" height="5px" viewBox="0 0 65 5">
                  <g id="Page-1" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
                    <g id="Desktop-HD-Copy-2" transform="translate(-975.000000, -1073.000000)" fill="#D8D8D8">
                      <g id="Group" transform="translate(975.000000, 1073.000000)">
                        <circle id="Oval-3" cx="2.5" cy="2.5" r="2.5"></circle>
                        <circle id="Oval-3" cx="32.5" cy="2.5" r="2.5"></circle>
                        <circle id="Oval-3" cx="62.5" cy="2.5" r="2.5"></circle>
                      </g>
                    </g>
                  </g>
                </svg>
              </Flex>
              <Flex styleOverrides={{width: "100%"}} justifyContent="space-between" alignItems="center">
                <p
                  style={{
                    fontFamily: "Georgia",
                    fontSize: 16,
                    lineHeight: 1.6,
                    color: "rgb(130,130,130)",

                  }}>

                  {"Colin Megill, a founder of pol.is, spoke at the "}
                  <a
                    style={{
                      fontFamily: "Georgia",
                      fontSize: 16,
                      color: "rgb(130,130,130)",
                    }}
                    href="http://summit.g0v.tw/2016/speakers">
                    {"g0v2016 conference"}
                  </a>
                  {" in Taipei, Taiwan. "}
                  {/*" For a digestible case study in 30 minutes, "*/}
                  <a
                    style={{
                      fontFamily: "Georgia",
                      fontSize: 16,
                      color: "rgb(130,130,130)",
                    }}
                    href="https://blog.pol.is/pol-is-in-taiwan-da7570d372b5#.n27hweazh">
                    {"Watch the talk & read the transcript on Medium."}
                  </a>
                </p>
                <img height="50" src="http://www.digitalartsonline.co.uk/cmsdata/features/3626921/medium-m-color-688.png"/>
              </Flex>
            </Flex>
          </Flex>
          <Flex styleOverrides={{padding: "40px 20px"}}>
            <a
              href="http://civichall.org/civicist/vtaiwan-democracy-frontier/"
              style={{
              fontFamily: "Georgia",
              fontSize: 24,
              maxWidth: "32.5em",
              lineHeight: 1.7,
              marginRight: 30,
              color: "rgb(130,130,130)",
            }}> "Proponents of open-source democracy, take note, we are on the verge of a breakthrough." </a>
            <img
              width={100}
              style={{borderRadius: 7}}
              src="https://pbs.twimg.com/profile_images/593902371341783040/OEPQIQnO.png"/>
          </Flex>
        </Flex>
        <div
          style={{
            width: "100%",
            display: "block",
            backgroundColor: "#03a9f4",
            padding: "0px 0px 30px 0px"
          }}>
          <Flex>
          <p style={[this.styles().videoSectionTitle]}> A Hands-on Demo & Walkthrough </p>
          </Flex>
          <Flex>
          <iframe
            width="640"
            height="360"
            style={{border: "10px solid white", borderRadius: 4, margin: "auto"}}
            src="https://www.youtube.com/embed/FrIin_omVn4?rel=0&amp;showinfo=0"
            frameborder="0"
            allowfullscreen>
          </iframe>
          </Flex>
        </div>
        <div style={{width: "100%"}}>
          <div
            key="1"
            style={[this.styles().section, {backgroundColor: "rgb(240,240,240)"}]}
            >
            <div style={this.styles().iconWrapper}>
              <Awesome style={this.styles().icon} name="cloud"/>
            </div>
            <p style={this.styles().forText}> pol.is is cloud hosted SaaS. No deployment necessary. Embed pol.is in an iFrame on your site. </p>
          </div>
        </div>
        <div style={{width: "100%"}}>
          <div
            key="2"
            style={[this.styles().section, {backgroundColor: "rgb(230,230,230)"}]}
            >
            <div style={this.styles().iconWrapper}>
              <Awesome style={this.styles().icon} name="github"/>
            </div>
            <p style={this.styles().forText}>pol.is is <strong>open source.</strong> Adopt & build process on top of it with confidence: it’s here to stay. </p>
          </div>
        </div>
        <Flex
          alignItems="center"
          styleOverrides={[this.styles().callToActionContainer, {paddingTop: 30}]}>
          <Flex
            styleOverrides={this.styles().callToActionInnerFlex}
            direction="column"
            alignItems="flex-start">
            <p style={[this.styles().videoSectionTitle, {color: "rgb(130,130,130)", margin: "0px 0px 20px 0px"}]}> Get In Touch </p>
            <input
              placeholder="Name"
              style={this.styles().waitingListInput}
              ref="namelower"
              type="name"/>
            <input
              placeholder="Email"
              style={this.styles().waitingListInput}
              ref="emaillower"
              type="email"/>
            <input
              placeholder="Organization"
              style={this.styles().waitingListInput}
              ref="affiliationlower"
              type="affiliation"/>
            <input
              placeholder="Role"
              style={this.styles().waitingListInput}
              ref="rolelower"
              type="role"/>
            <Button
              onClick={this.handleJoinWaitingListClickedLower.bind(this)}
              style={this.styles().waitingListButton}>
              Contact Me
            </Button>
          <div style={{margin: 10}}>
            {this.maybeErrorMessage(this.state.errorTextLower)}
            {this.maybeSuccessMessage(this.state.successTextLower)}
          </div>
        </Flex>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default Gov;
