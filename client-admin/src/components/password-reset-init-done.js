// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import Flex from "./framework/flex";
import Awesome from "react-fontawesome";
import StaticContentContainer from "./framework/static-content-container";

const styles = {
  heading: {
    color: "rgb(160,160,160)",
    fontSize: 24,
    display: "block",
    margin: 0,
  },
  card: {
    position: "relative",
    zIndex: 10,
    padding: "50px",
    borderRadius: 3,
    color: "white",
  },
  button: {
    display: "block",
  },
  input: {
    display: "block",
    margin: "10px 0px",
    color: "rgb(100,100,100)",
    fontSize: 14,
    padding: 7,
    borderRadius: 3,
    border: "1px solid rgb(200,200,200)",
  },
  awesome: {
    marginRight: 20,
  },
};

@connect()
@Radium
class PasswordResetInitDone extends React.Component {
  render() {
    return (
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}
      >
        <Flex>
          <div style={styles.card}>
            <p style={styles.heading}>
              <Awesome style={styles.awesome} name="envelope" />
              Check your email for a password reset link
            </p>
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default PasswordResetInitDone;
