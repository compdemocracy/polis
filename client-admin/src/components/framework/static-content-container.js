// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";
import Header from "./static-content-header";
import Footer from "./static-content-footer";

@Radium
class StaticContentContainer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  getStyles() {
    return {
      flexContainer: {
        minHeight: "100%",
        background: this.props.image
          ? "url(https://pol.is/landerImages/billions-compressor.jpeg) no-repeat center center fixed"
          : "",
        backgroundSize: this.props.image ? "cover" : "",
      },
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Flex
        styleOverrides={[styles.flexContainer, this.props.style]}
        justifyContent="space-between"
        direction="column"
        styleOverrides={styles.flexContainer}
      >
        <Header nologo={this.props.nologo} backgroundColor={this.props.headerBackgroundColor} />
        {this.props.children}
        <Footer backgroundColor={this.props.footerBackgroundColor} />
      </Flex>
    );
  }
}

export default StaticContentContainer;
