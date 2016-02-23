import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin, doFacebookSignin } from "../../actions";
import Radium from "radium";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import StaticContentContainer from "../framework/static-content-container";
import landerStyles from "./lander-styles";


@connect()
@Radium
class News extends React.Component {
  render() {
    return (
      <StaticContentContainer image={false} stars={{visible: false, color: "darkgrey"}}>
        {/* hero */}
        <Flex
          direction="column"
          alignItems="center"
          grow="1"
          styleOverrides={landerStyles().sectionColor}>
            <p style={landerStyles().hero}>
              {"Make your content work harder"}
            </p>
            <p style={landerStyles().heroSub}>
              {
                `Become the center of gravity for conversations
                about the issues your audience respects you for most.`
              }
            </p>
        </Flex>
        {/* upper cta */}
        <Flex styleOverrides={landerStyles().callToAction}>
          <Button
            style={{
              backgroundColor: "cornflowerblue",
              color: "white"
            }}> Get pol.is </Button>
        </Flex>
        {/* body */}

        <Flex
          wrap={"wrap"}
          justifyContent={"space-around"}
          alignItems={"baseline"}
          styleOverrides={landerStyles().body}>
          <Flex
            styleOverrides={landerStyles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={landerStyles().sectionHeader}>
              {"Take Power Back From Social Media"}
            </p>
            <p style={landerStyles().sectionBody}>
              { `Pol.is can help you centralize and highlight discussions of
                critical issues on your site, drawing in users from social
                platforms who want their voices heard.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={landerStyles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={landerStyles().sectionHeader}>
              {"Get More Readers in the Game"}
            </p>
            <p style={landerStyles().sectionBody}>
              {
                `Your audience could fill stadiums. Shouldn't your UGC
                features accomodate more than a cocktail party? Polis engages
                a much larger percentage of your audience, and stays
                interesting regardless of how many people want to engage
                - even if that means hundreds of thousands.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={landerStyles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={landerStyles().sectionHeader}>
              {"Engage Your Brightest, Busiest Readers"}
            </p>
            <p style={landerStyles().sectionBody}>
              {
                `High profile, social media savvy readers don't have a
                great incentive to comment on your site. Pol.is engages your
                best readers by showing them how they compare to others, and gets
                them noticed if they have a high follower count.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={landerStyles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={landerStyles().sectionHeader}> {"Usable Data"} </p>
            <p style={landerStyles().sectionBody}>
              {
                `Pol.is data can instruct content and editorial in real time.
                Use powerful dashboard tools to drill into conversations as
                they’re unfolding. Gain insights about participation
                patterns, data quality and audience.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={landerStyles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={landerStyles().sectionHeader}> {"10x"} </p>
            <p style={landerStyles().sectionBody}>
              {
                `On average, ~10x more people submit votes than comment.
                If you get hundreds of comments, expect thousands of voters.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={landerStyles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={landerStyles().sectionHeader}>
              {"Up and Running in Minutes"}
            </p>
            <p style={landerStyles().sectionBody}>
              {
                `Just drop a script tag onto your site and you"re
                on your way - no messy integrations.`
              }
            </p>
          </Flex>
        </Flex>
        {/* lower cta */}
        <Flex styleOverrides={landerStyles().callToAction}>
          <Button
            backgroundColor={"transparent"}
            backgroundColorHover={"rgb(100,100,100)"}
            backgroundColorActive={"rgb(100,100,100)"}
            backgroundColorFocus={"rgb(100,100,100)"}
            color={"rgb(100,100,100)"}
            textColorHover={"white"}
            textColorFocus={"white"}
            textColorActive={"white"}
            border={"2px solid rgb(100,100,100)"}> Learn More </Button>
        </Flex>

      </StaticContentContainer>
    );
  }
}

export default News;
        //
        // <Flex styleOverrides={landerStyles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={landerStyles().flexTestDiv}> foo </Flex>
        // <Flex grow={1} styleOverrides={landerStyles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={landerStyles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={landerStyles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={landerStyles().flexTestDiv}> foo </Flex>
