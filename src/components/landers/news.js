import InputField from 'material-ui/lib/text-field';
import React from 'react';
import { connect } from 'react-redux';
import { doSignin, doFacebookSignin } from '../../actions';
import Radium from 'radium';
import Awesome from 'react-fontawesome';
import Flex from '../framework/flex';
import Button from '../framework/generic-button';
import StaticContentContainer from '../framework/static-content-container';

@connect()
@Radium
class News extends React.Component {
  styles () {
    return {
      container: {
        minWidth: '100vw',
        zIndex: 10
      },
      sectionColor: {
        minWidth: '100vw',
        backgroundColor: 'rgb(230,230,230)',
      },
      hero: {
        fontSize: 48,
        maxWidth: 600,
        padding: "0px 40px",
        zIndex: 10,
      },
      heroSub: {
        fontSize: 24,
        padding: "0px 40px",
        maxWidth: 600,
        zIndex: 10,
      },
      callToAction: {
        width: '100vw',
        padding: "30px 0px",
        backgroundColor: 'rgb(230,230,230)',
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
      subheading: {
        maxWidth: 500,
        lineHeight: 1.5
      },
      button: {
        backgroundColor: 'white',
        color: 'rgb(100,100,100)'
      },
      flexTestContainer: {
        minHeight: "100%"
      },
      flexTestDiv: {
        backgroundColor: 'red',
        color: "white",
        minHeight: 50,
        width: "100%",
      }
    }
  }
  render() {
    return (
      <StaticContentContainer image={false} stars={{visible: false, color: "darkgrey"}}>
        {/* hero */}
        <Flex
          direction='column'
          alignItems='center'
          grow='1'
          styleOverrides={this.styles().sectionColor}>
            <p style={this.styles().hero}>
              {'Make your content work harder'}
            </p>
            <p style={this.styles().heroSub}>
              {
                `Turn your site into a center of gravity for conversations
                around the issues your audience respects you for the most.`
              }
            </p>
        </Flex>
        {/* upper cta */}
        <Flex styleOverrides={this.styles().callToAction}>
          <Button
            backgroundColor={'transparent'}
            backgroundColorHover={'rgb(100,100,100)'}
            backgroundColorActive={'rgb(100,100,100)'}
            backgroundColorFocus={'rgb(100,100,100)'}
            color={'rgb(100,100,100)'}
            textColorHover={'white'}
            textColorFocus={'white'}
            textColorActive={'white'}
            border={'2px solid rgb(100,100,100)'}> Get pol.is </Button>
        </Flex>
        {/* body */}

        <Flex
          wrap={"wrap"}
          justifyContent={'space-around'}
          alignItems={'baseline'}
          styleOverrides={this.styles().body}>
          <Flex
            styleOverrides={this.styles().section}
            direction='column'
            alignItems={'flex-start'}>
            <p style={this.styles().sectionHeader}>
              {'Take the Power Back From Social Media'}
            </p>
            <p style={this.styles().subheading}>
              { `You produce the content, and you should benefit from the
                dialogue around it. You care deeply about the places and issues
                you cover, and are qualified to moderate constructive dialogue.
                Pol.is can help you centralize and highlight discussions of
                critical issues on your site, away from the echo chamber of
                Twitter and Facebook.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction='column'
            alignItems={'flex-start'}>
            <p style={this.styles().sectionHeader}>
              {'Scale Up Engagement'}
            </p>
            <p style={this.styles().subheading}>
              {
                `Your audience could fill stadiums. Shouldn't your comment
                threads accomodate more than a cocktail party? Polis engages
                a much larger percentage of your audience, and stays
                interesting regardless of how many people want to engage
                - even if that's hundreds of thousands.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction='column'
            alignItems={'flex-start'}>
            <p style={this.styles().sectionHeader}>
              {'Delight Your Brightest, Busiest Readers'}
            </p>
            <p style={this.styles().subheading}>
              {
                `Give your most social media savvy participants an incentive
                to share their thoughts on your site. Pol.is engages your best
                readers by showing them how they compare to others, and gets
                them noticed if they have a high follower count.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction='column'
            alignItems={'flex-start'}>
            <p style={this.styles().sectionHeader}> {'Reap Usable Data'} </p>
            <p style={this.styles().subheading}>
              {
                `Pol.is data can instruct content and editorial in real time.
                Use powerful dashboard tools to drill into conversations as
                they’re unfolding to gain insights about participation
                patterns, data quality and audience.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction='column'
            alignItems={'flex-start'}>
            <p style={this.styles().sectionHeader}> {'10x'} </p>
            <p style={this.styles().subheading}>
              {
                `On average, ~10x more people submit votes than comment.
                If you get hundreds of comments, expect thousands of voters.`
              }
            </p>
          </Flex>
          <Flex
            styleOverrides={this.styles().section}
            direction='column'
            alignItems={'flex-start'}>
            <p style={this.styles().sectionHeader}>
              {'Up and Running in Minutes'}
            </p>
            <p style={this.styles().subheading}>
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
            backgroundColor={'transparent'}
            backgroundColorHover={'rgb(100,100,100)'}
            backgroundColorActive={'rgb(100,100,100)'}
            backgroundColorFocus={'rgb(100,100,100)'}
            color={'rgb(100,100,100)'}
            textColorHover={'white'}
            textColorFocus={'white'}
            textColorActive={'white'}
            border={'2px solid rgb(100,100,100)'}> Learn More </Button>
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
