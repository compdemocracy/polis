// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import {Link} from "react-router";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import StaticContentContainer from "../framework/static-content-container";
import strings from "../../strings/strings";

const styles = {
  container: {
    padding: 20,
    marginBottom: 40,
    maxWidth: "31em"
  },
  heading: {
    fontSize: 36,
    fontWeight: 300,
    display: "block",
    marginBottom: 20,
    marginTop: 0,
    textAlign: "center"
  },
  bodyText: {
    fontWeight: 300,
    lineHeight: 1.8,
    letterSpacing: 1.15,
    fontFamily: "Georgia"
  },
  pic: {
    width: 150,
    borderRadius: 100
  },
  clipping: {
    marginBottom: 20
  },
  publication: {
    marginRight: "1em",
    width: "10em"
  },
  pressURL: {
    color: "black",
    maxWidth: "20em"
  }
};

@Radium
class Company extends React.Component {

  render() {
    return (
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}>
        <Flex styleOverrides={styles.container}>
          <div>
            <p style={[styles.heading, {marginTop: 20, marginBottom: 30}]}>
              Company
            </p>
            <p style={styles.bodyText}>
              {"We’re a small, focused team of technologists trying to make the world a better place with surprisingly smart software. We love web, AI & OSS."}
            </p>
            <p style={[styles.heading, {marginTop: 50, marginBottom: 30}]}>
              Founding Team
            </p>
            <Flex styleOverrides={{marginBottom: 30}} direction="column">
              <img style={styles.pic} src="https://pol.is/landerImages/18Ys8Byj.jpeg"/>
              <div>
              <p style={styles.bodyText}>
                Colin Megill
                <span style={{margin: "0px 8px"}}>•</span>
                CEO
                </p>
              </div>
              <a href="https://twitter.com/colinmegill">
                <Awesome style={{fontSize: 18, color: "#4099FF"}} name={"twitter"}/>
              </a>
            </Flex>
            <Flex styleOverrides={{marginBottom: 30}} direction="column">
              <img style={styles.pic} src="https://pol.is/landerImages/MItXxpoe.jpg"/>
              <div>
              <p style={styles.bodyText}>
                Michael Bjorkegren
                <span style={{margin: "0px 8px"}}>•</span>
                CTO
                </p>
              </div>
              <a href="https://twitter.com/mbjorkegren">
                <Awesome style={{fontSize: 18, color: "#4099FF"}} name={"twitter"}/>
              </a>
            </Flex>
            <Flex styleOverrides={{marginBottom: 30}} direction="column">
              <img style={styles.pic} src="https://pol.is/landerImages/th-BO255.jpeg"/>
              <div>
              <p style={styles.bodyText}>
                Christopher Small
                <span style={{margin: "0px 8px"}}>•</span>
                Lead Data Scientist
                </p>
              </div>
              <a href="https://twitter.com/metasoarous">
                <Awesome style={{fontSize: 18, color: "#4099FF"}} name={"twitter"}/>
              </a>
            </Flex>
            <p style={[styles.heading, {marginTop: 50, marginBottom: 30}]}>
              Mission & Vision
            </p>
            <p style={styles.bodyText}>
              pol.is was conceived around the time of Occupy Wall Street and the Arab Spring.
              We felt if millions of people were going to show up to a conversation, the internet needed something that would scale up.
              We set out to build a communication system that would handle 'big' and stay coherent.
              We wanted people to feel safe & listened to, and we felt it was of the highest importance that minority opinions be preserved rather than 'outvoted'.

              <p style={styles.bodyText}> Most generally, we leverage advances in mobile connectivity, artificial intelligence and machine learning to build tools that provide transparency, produce insight and decentralize power in all kinds of organizations of people everywhere on Earth. </p>
            </p>
            <p id="press" style={[styles.heading, {marginTop: 50, marginBottom: 30}]}>
              Press
            </p>


            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Nesta (UK) </span>
              <a style={styles.pressURL} href="http://www.nesta.org.uk/blog/corbyn-wants-tools-massive-multi-person-online-deliberation-here-are-some-ways-he-could-do-it"> Corbyn wants tools for 'massive-multi-person online deliberation' - here are some ways he could do it </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Civicist </span>
              <a style={styles.pressURL} href="http://civichall.org/civicist/vtaiwan-democracy-frontier/"> vTaiwan: Public Participation Methods on the Cyberpunk Frontier of Democracy </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Le Monde (French) </span>
              <a style={styles.pressURL} href="http://www.lemonde.fr/idees/article/2016/05/25/une-experience-pionniere-de-democratie-numerique-a-taiwan_4926104_3232.html"> "A Pioneering Experience of Digital Democracy" in Taiwan </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Intium (Chinese) </span>
              <a style={styles.pressURL} href="https://theinitium.com/article/20160606-taiwan-g0v/"> "Why is Taiwan's Open Source Movement a Model for The World?" </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Greenpeace MobLab </span>
              <a style={styles.pressURL} href="http://www.mobilisationlab.org/blooming-digital-democracy-taiwan-sunflower-movement/#.Vur9oxIrLUI"> "Blooming digital democracy in Taiwan’s Sunflower movement: How technologists and activists are working together to mobilise a nation" </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Coral Project </span>
              <a style={styles.pressURL} href="https://coralproject.net/new-community-tools-polis/"> New community tools: pol.is </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Poynter </span>
              <a style={styles.pressURL} href="http://www.poynter.org/2016/here-are-27-ways-to-think-about-comments/401728/"> Here are 27 ways to think about comments </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> Daum (Korean) </span>
              <a style={styles.pressURL} href="http://m.media.daum.net/m/media/world/newsview/20160302145809114"> "We want to change the relationship between citizens and government" </a>
            </Flex>
            <Flex justifyContent="flex-start" alignItems="baseline" styleOverrides={[styles.bodyText, styles.clipping]}>
              <span style={styles.publication}> GeekWire </span>
              <a style={styles.pressURL} href="http://www.geekwire.com/2014/startup-spotlight-polis/"> Startup Spotlight: pol.is </a>
            </Flex>
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default Company;
