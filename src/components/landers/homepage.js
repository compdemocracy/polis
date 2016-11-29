// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import { browserHistory } from "react-router";
// import Awesome from "react-fontawesome";
import {Link} from "react-router";
import StaticContentContainer from "../framework/static-content-container";
import Banner from "../framework/trial-banner";
import Stars from "../framework/background-stars";

const styles = {
  heading: {
    color: "white",
    maxWidth: 900,
    fontSize: 36,
    fontWeight: 700,
    margin: "20px 0px 10px 0px",
  },
  subheading: {
    color: "white",
    fontSize: 24,
    maxWidth: 600,
    lineHeight: 1.9,
  },
  body: {
    color: "white",
    fontSize: 16,
    maxWidth: 600,
    fontWeight: 300,
    lineHeight: 1.9,
  }
};

@Radium
class Homepage extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      word: 0,
      words: [
        "organic",
        "engaging",
        "authentic",
        "effortless",
        "interactive"
      ]
    };
  }
  componentDidMount() {
    setInterval(() => {
      let newWord = this.state.word;
      newWord++;
      if (newWord > this.state.words.length -1) {
        newWord = 0;
      }
      this.setState({word: newWord})
    }, 6000)
  }
  renderStars() {
    return (
      <Stars
        text={""}
        top={50}
        nodeColor={ "rgb(150,150,150)" }
        count={ Math.floor(window.innerWidth / 20) }
        width={ window.innerWidth }
        height={ window.innerHeight / 1.5 }
        radius={ 1.5 }
        lineWidth={ 1 }/>
    );
  }
  handleGetStartedClicked(r) {
    return () => {
      browserHistory.push(r);
    };
  }
  render() {
    return (
      <StaticContentContainer stars={{visible: true, color: "white"}}>
        <div style={{margin: 20}}>
          <p style={styles.heading}>
            {`pol.is means ${this.state.words[this.state.word]} feedback`}
          </p>
          <p style={styles.subheading}>
            {`the internet has scaled up our ability to talk`}
            <br/>
            {`pol.is scales up our ability to listen`}
          </p>
          <p style={styles.body}>
            {
              `Polis is a new kind of commenting & survey system radically enhanced with
              machine learning and real-time data visualization. Use it to get
              better bottom up feedback and host online discussions that scale
              effectively.`
            }
          </p>
          <Button
            onClick={this.handleGetStartedClicked("createuser")}
            style={{
              marginTop: 20,
              backgroundColor: "cornflowerblue",
              color: "white"
            }}>
          Get started
          </Button>
        </div>
      </StaticContentContainer>
    );
  }
}

export default Homepage;
