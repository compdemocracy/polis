// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import Flex from "../framework/flex";

@Radium
class Benefit extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
  }

  getStyles() {
    return {
      section: {
        padding: 0,
        width: "100%"
      },
      step: {
        marginBottom: 0,
        width: "100%",
      },
      stepText: {
        fontSize: "2.2em",
        margin: 0,
        color: "rgb(130,130,130)",
        padding: 10,
        borderRadius: 100,
      },
      sectionBody: {
        maxWidth: 400,
        margin: "auto",
        padding: 20,
        fontSize: "1.2em",
        fontWeight: 300,
        lineHeight: 1.8,
        textAlign: "center"
      },
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Flex
        styleOverrides={this.getStyles().section}
        direction="column"
        justifyContent="center"
        alignItems={"flex-start"}>
        <Flex justifyContent="center" styleOverrides={this.getStyles().step}>
          <p style={this.getStyles().stepText}>{this.props.step}</p>
        </Flex>
        <p style={this.getStyles().sectionBody}>
          {this.props.body}
        </p>
      </Flex>
    );
  }
}

export default Benefit;
