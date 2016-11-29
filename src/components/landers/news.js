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
import Benefit from "./benefit";

// import { Tweet } from 'react-twitter-widgets';

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
        backgroundColor: "#03a9f4",
        color: "white"
      },
      hero: {
        fontSize: 48,
        lineHeight: 1.4,
        textTransform: 'uppercase',
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
      callToAction: {
        width: "100vw",
        padding: "30px 0px",
        backgroundColor: "#03a9f4",
      },
      getStartedButton: {
        backgroundColor: "rgb(255,191,31)",
        color: "white"
      },
      body: {
        padding: 40
      },
      section: {
        padding: 0,
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
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}>
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
              pol.is is an embeddable discussion platform that engages more of your readers
              in meaningful conversation, with less burden on you.
            </p>
        </Flex>
        {/* upper cta */}
        <Flex styleOverrides={this.styles().callToAction}>
          <Button
            onClick={this.handleGetStartedClicked("createuser")}
            style={this.styles().getStartedButton}> Get started </Button>
        </Flex>
        <Press/>
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
                an <span style={{fontWeight: 700}}>interactive feature</span> that you
                can effortlessly embed on your digital content.
                It works in addition to, or as a replacement for, your existing commenting system.
            </p>
            <p style={this.styles().sectionBody}>
              {`
                Pol.is uses artificial intelligence & machine learning to produce `}
                <span style={{fontWeight: 700}}>opinion groups.</span> All users

                {` can see where they stand relative to others on the issues in an interactive visualization.
              `}
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
          styleOverrides={this.styles().bandSection}
          direction="column"
          alignItems={"center"}>
          <p style={this.styles().sectionHeader}>
            {"Hands Free Mode"}
          </p>
          <p style={this.styles().sectionBody}>
            {`
              Stop moderating if you want to - pol.is will make conversations
              great automatically by intelligently routing comments algorithmically.
            `}
          </p>
        </Flex>
        <Flex
          wrap={"wrap"}
          justifyContent={"space-around"}
          alignItems={"baseline"}
          styleOverrides={this.styles().body}>
          <Benefit
            heading={"Take Power Back From Social Media"}
            body={`
              Pol.is can help you leverage your brand to centralize discussions,
              drawing in users who want their voices heard. You'll immediately
              see users you haven't seen before, of a higher profile than
              you're used to, engaging with your content.
              `}/>
          <Benefit
            heading={"Get More Readers in the Game"}
            body={`
              Your audience could fill stadiums. Shouldn't your UGC
              features accomodate more than a cocktail party? Polis engages
              a much larger percentage of your audience, and stays
              interesting regardless of how many people want to engage
              - even if that means hundreds of thousands.
              `}/>
          <Benefit
            heading={"Engage Your Brightest, Busiest Readers"}
            body={`
              High profile, social media savvy readers don't have a
              great incentive to comment on your site. Pol.is gives them one by
              showing them how their views compare to others, and gets
              them noticed if they have a high follower count. You can manually
              curate who is seen as well.
              `}/>
          <Benefit
            heading={"Usable Data"}
            body={`
              Pol.is data can instruct content and editorial in real time.
              Use powerful dashboard tools to drill into conversations as
              they’re unfolding. pol.is produces
              lots of usable data that immediately helps you understand your audience's
              experience of your content.
              `}/>
          <Benefit
            heading={"10x"}
            body={`
              That's a big engagement boost over existing UGC methods.
              `}/>
          <Benefit
            heading={"Up and Running in Minutes"}
            body={`
              Just drop a script tag onto your site and you're
              on your way - no messy integrations.
              `}/>
        </Flex>
        {/* lower cta */}
        <Flex styleOverrides={this.styles().callToAction}>
          <Button
            style={this.styles().getStartedButton}> Get started </Button>
        </Flex>

      </StaticContentContainer>
    );
  }
}

export default News;
