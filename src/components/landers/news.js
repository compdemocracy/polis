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

@connect()
@Radium
class News extends React.Component {
  styles() {
    return {
      container: {
        minWidth: "100vw",
        zIndex: 10
      },
      sectionColor: {
        minWidth: "100vw",
        backgroundColor: "rgb(230,230,230)",
      },
      hero: {
        fontSize: 48,
        maxWidth: 600,
        padding: "0px 40px",
        zIndex: 10,
      },
      heroSub: {
        fontSize: 24,
        fontWeight: 300,
        margin: 0,
        padding: "0px 40px",
        maxWidth: 600,
        zIndex: 10,
      },
      callToAction: {
        width: "100vw",
        padding: "30px 0px",
        backgroundColor: "rgb(230,230,230)",
      },
      body: {
        padding: 40
      },
      section: {
        padding: 0,
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
      }
    }
  }
  handleGetStartedClicked(r) {
    return () => {
      browserHistory.push(r);
    };
  }
  render() {
    return (
      <StaticContentContainer image={false} stars={{visible: true, color: "darkgrey"}}>
        {/* hero */}
        <Flex
          direction="column"
          alignItems="center"
          grow="1"
          styleOverrides={this.styles().sectionColor}>
            <p style={this.styles().hero}>
              {"Make your content work harder"}
            </p>
            <p style={this.styles().heroSub}>
              {
                `Become the center of gravity for conversations
                about the issues your audience respects you for most.`
              }
            </p>
        </Flex>
        {/* upper cta */}
        <Flex styleOverrides={this.styles().callToAction}>
          <Button
            onClick={this.handleGetStartedClicked("createuser")}
            style={{
              backgroundColor: "cornflowerblue",
              color: "white"
            }}> Get started </Button>
        </Flex>
        <Flex
          wrap={"wrap"}
          justifyContent={"space-around"}
          alignItems={"flex-start"}
          styleOverrides={this.styles().body}>
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionBody}>
                Pol.is is
                an <span style={{fontWeight: 700}}>interactive feature</span> you
                can add to your site in minutes.
                It works in addition to, or as a replacement for, your existing commenting system.
                Users can optionally submit their own words. Primarily, they
                can agree or disagree with comments submitted by others. We find
                across conversations that <span style={{fontWeight: 700}}>around 10 times
                more people</span> vote than comment.
                That's a big engagement boost over existing UGC methods.
            </p>
            <p style={this.styles().sectionBody}>
                Pol.is does some fancy
                math (<span style={{fontWeight: 700}}>artificial intelligence & machine learning</span>) and
                produces opinion groups (using interactive data visualization). These
                are groups of participants that tended to vote the same way across
                many comments. This shows users how their views compare to others
                that are reading the same article - ie., whether they are in the
                majority or minority. It also shows them (and you!) broad consensus.
            </p>
            <p style={this.styles().sectionBody}>
                If you're interested in learning more about features and usage before
                creating an
                account, <a style={{
                  color: "black",
                  fontWeight: 700
                }} target="_blank" href="http://docs.pol.is">check out the docs</a>.
            </p>
          </Flex>
          <Flex wrap="wrap" styleOverrides={{maxWidth: 700}}>
            <img
              style={{
                position: "relative",
                left: "17%"
              }}
              width="15%"
              src="https://pol.is/images/iphone_product_shot.png"/>
            <img width="75%" src="https://pol.is/images/macbook_product_shot.png"/>
          </Flex>
        </Flex>
        <Flex
          wrap={"wrap"}
          justifyContent={"space-around"}
          alignItems={"baseline"}
          styleOverrides={this.styles().body}>
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}>
              {"Take Power Back From Social Media"}
            </p>
            <p style={this.styles().sectionBody}>
              { `Pol.is can help you centralize and highlight discussions of
                critical issues on your site, drawing in users from social
                platforms who want their voices heard.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}>
              {"Get More Readers in the Game"}
            </p>
            <p style={this.styles().sectionBody}>
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
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}>
              {"Engage Your Brightest, Busiest Readers"}
            </p>
            <p style={this.styles().sectionBody}>
              {
                `High profile, social media savvy readers don't have a
                great incentive to comment on your site. Pol.is engages your
                best readers by showing them how they compare to others, and gets
                them noticed if they have a high follower count.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}> {"Usable Data"} </p>
            <p style={this.styles().sectionBody}>
              {
                `Pol.is data can instruct content and editorial in real time.
                Use powerful dashboard tools to drill into conversations as
                they’re unfolding. Gain insights about participation
                patterns, data quality and audience.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}> {"10x"} </p>
            <p style={this.styles().sectionBody}>
              {
                `On average, ~10x more people vote than submit comments.
                If you get hundreds of comments, expect thousands of voters.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}>
              {"Up and Running in Minutes"}
            </p>
            <p style={this.styles().sectionBody}>
              {
                `Just drop a script tag onto your site and you're
                on your way - no messy integrations.`
              }
            </p>
          </Flex>
        </Flex>
        {/* lower cta */}
        <Flex styleOverrides={this.styles().callToAction}>
          <Button
            style={{
              backgroundColor: "cornflowerblue",
              color: "white"
            }}> Get started </Button>
        </Flex>

      </StaticContentContainer>
    );
  }
}

export default News;
        //
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex grow={1} styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
