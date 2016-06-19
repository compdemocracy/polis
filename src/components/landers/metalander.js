import Awesome from "react-fontawesome";
import BackgroundStars from "../framework/background-stars";
import Button from "../framework/generic-button";
import Flex from "../framework/flex";
import InputField from "material-ui/lib/text-field";
import PolisLogo from "../framework/polis-logo";
import PolisNet from "../../util/net";
import Radium from "radium";
import React from "react";
import StaticContentContainer from "../framework/static-content-container";
import strings from "../../strings/strings";
import HexLogoLargeShort from "../framework/hex-logo-large-short";
import GovFlat from "../framework/govFlat";
import PublishersFlat from "../framework/publishersFlat";
import { browserHistory } from "react-router";

@Radium
class MetaLander extends React.Component {
  styles() {
    return {
      heroContainer: {
        width: "100%",
        height: "auto",
        zIndex: 10,
        backgroundColor: "#03a9f4",

      },
      polis: {
        fontFamily: "Georgia",
        color: "white",
        fontSize: "4em",
        letterSpacing: "6.61",
        position: "relative",
        left: 8,
        margin: 10
      },
      subtext: {
        fontFamily: "Georgia",
        color: "white",
        fontSize: "2.5em",
        maxWidth: 500,
        textAlign: "center",
        lineHeight: 1.4,
        letterSpacing: "6.61",
        marginBottom: 50
      },
      goSection: {
        /* WHEN IT'S SMALL AND UP (DEFAULT) */
        width: "100%",
        display: "flex",
        textDecoration: "none",
        opacity: "0.95",
        ':hover': {
          opacity: "1",
        },
        cursor: "pointer",
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
      publishers: {
        backgroundColor: "#FFB700",
        zIndex: -100
      },
      slack: {
        backgroundColor: "#FFA33C",
        zIndex: -200
      },
      gov: {
        backgroundColor: "#FF613C",
        zIndex: -300
      },
      iconWrapper: {
        marginTop: 20,
        "@media (min-width: 768px)": {
          marginLeft: 30,
          width: 250,
        }
      },
      forText: {
        color: "#FFFFFF",
        width: 300,
        fontSize: "2em",
        fontWeight: 300,
        textAlign: "center",
        "@media (min-width: 768px)": {
          textAlign: "left"
        }
      },
      publisherIcon: {

      },
      slackIcon: {

      },
      govIcon: {

      }
    }
  }
  // goTo(r) {
  //   return () => {
  //     browserHistory.push(r);
  //   };
  // }
  render() {
    return (
      <StaticContentContainer
        nologo
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}
        stars={{visible: true, color: "darkgrey"}}>
        {/* hero */}
        <Flex
          styleOverrides={this.styles().heroContainer}
          direction="column"
          justifyContent="flex-start"
          alignItems="center"
          >
          <HexLogoLargeShort invert/>
          <p style={this.styles().polis}> pol.is </p>
          <p style={this.styles().subtext}> AI powered conversations </p>
        </Flex>
        <div style={{width: "100%"}}>
          <a
            href="/news"
            key="1"
            style={[this.styles().goSection, this.styles().publishers]}
            >
            <div style={this.styles().iconWrapper}>
              <PublishersFlat/>
            </div>
            <p style={this.styles().forText}> For Publishers and Readers </p>
          </a>
        </div>
        <div style={{width: "100%"}}>
          <a
            href="/bot"
            key="2"
            style={[this.styles().goSection, this.styles().slack]}
            >
            <div style={this.styles().iconWrapper}>
              <img width="200" src="https://assets.brandfolder.com/irnq5s6s/original/slack_monochrome_white.png"/>
            </div>
            <p style={this.styles().forText}> For Teams on Slack </p>
          </a>
        </div>
        <div style={{width: "100%"}}>
          <a
            href="/gov"
            key="3"
            style={[this.styles().goSection, this.styles().gov]}
            >
            <div style={this.styles().iconWrapper}>
              <GovFlat/>
            </div>
            <p style={this.styles().forText}> For Governments & Citizens </p>
          </a>
        </div>
      </StaticContentContainer>
    );
  }
}

export default MetaLander;
