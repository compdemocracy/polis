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
// import { Tweet } from 'react-twitter-widgets';

@connect()
@Radium
class Crowd extends React.Component {
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
      newsLogo: {
        width: 170
      },
      body: {
        padding: 40
      },
      section: {
        padding: 0,
      },
      pressSection: {
        backgroundColor: "rgb(230,230,230)",
        color: "darkgray",
        width: "100vw",
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
        image={false}
        stars={{visible: true, color: "darkgrey"}}>
        {/* hero */}
        <Flex
          direction="column"
          alignItems="center"
          grow="1"
          styleOverrides={this.styles().sectionColor}>
            <p style={this.styles().hero}>
              {"What does your crowd think?"}
            </p>
            <p style={this.styles().heroSub}>
              Meet pol.is: an open source, AI powered sentiment gathering platform.
              More organic than surveys, less effort than focus groups.
            </p>
        </Flex>
        {/* upper cta */}
        <Flex styleOverrides={this.styles().callToAction}>
          <Button
            onClick={this.handleGetStartedClicked("createuser")}
            style={this.styles().getStartedButton}> Get started </Button>
        </Flex>
        <Flex
          styleOverrides={this.styles().pressSection}
          direction="column"
          alignItems={"center"}>
          <Flex
            styleOverrides={{width: "100%"}}
            wrap="wrap"
            justifyContent={"space-around"}>
            <a href="http://www.geekwire.com/2014/startup-spotlight-polis/">
              <img style={this.styles().newsLogo} src="http://cdn.geekwire.com/wp-content/uploads/2015/02/GeekWire-logo-transparent.png"/>
            </a>
            <a href="http://m.media.daum.net/m/media/world/newsview/20160302145809114">
              <img style={this.styles().newsLogo} src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Daum_communication_logo.svg/2000px-Daum_communication_logo.svg.png"/>
            </a>
            <a href="http://www.poynter.org/2016/here-are-27-ways-to-think-about-comments/401728/">
              <img style={this.styles().newsLogo} src="http://atendesigngroup.com/sites/all/themes/aten2014/images/logos/logo--poynter.png"/>
            </a>
            <a href="http://www.mobilisationlab.org/blooming-digital-democracy-taiwan-sunflower-movement/#.Vur9oxIrLUI">
              <img style={this.styles().newsLogo} src="http://www.mobilisationlab.org/wp-content/themes/eleven40/images/logo-mob-lab-sq.png"/>
            </a>
            <a href="https://coralproject.net/new-community-tools-polis/">
              <img style={this.styles().newsLogo} src="https://coralproject.net/wp-content/uploads/2015/10/coralWordMark-1.5.png"/>
            </a>
          </Flex>
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
                an <span style={{fontWeight: 700}}>interactive feature</span> that you
                can effortlessly embed on your digital content.
                It works in addition to, or as a replacement for, your existing commenting system.
            </p>
            <p style={this.styles().sectionBody}>
              {`
                Pol.is does some fancy math
              `}
                <span style={{fontWeight: 700}}>(artificial intelligence & machine learning)</span>
              {`
                to produce opinion groups. All users
                can see where they stand relative to others on the issues in an interactive visualization.
              `}
            </p>
            <p style={this.styles().sectionBody}>
                If you are interested in learning more about features and usage before
                creating an
                account, <a style={{
                  color: "black",
                  fontWeight: 700
                }} target="_blank" href="http://docs.pol.is">check out the documentation</a>.
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
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}>
              {"Take Power Back From Social Media"}
            </p>
            <p style={this.styles().sectionBody}>
              {`
                Pol.is can help you leverage your brand to centralize discussions,
                drawing in users who want their voices heard. You'll immediately
                see users you haven't seen before, of a higher profile than
                you're used to, engaging with your content.
              `}
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
                great incentive to comment on your site. Pol.is gives them one by
                showing them how their views compare to others, and gets
                them noticed if they have a high follower count. You can manually
                curate who is seen as well.`
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
                they’re unfolding. pol.is produces
                lots of usable data that immediately helps you understand your audience's
                experience of your content.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction="column"
            alignItems={"flex-start"}>
            <p style={this.styles().sectionHeader}> {"10x"} </p>
            <p style={this.styles().sectionBody}>
              Our data shows that
                <span style={{fontWeight: 700}}> on average 10 times
                more people</span> vote in pol.is conversations than comment.
                {" That's a big engagement boost over existing UGC methods."}

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
            style={this.styles().getStartedButton}> Get started </Button>
        </Flex>

      </StaticContentContainer>
    );
  }
}

export default Crowd;
        //
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex grow={1} styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
        // <Flex styleOverrides={this.styles().flexTestDiv}> foo </Flex>
