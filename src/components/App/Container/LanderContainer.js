// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { PropTypes } from "react";
import { connect } from "react-redux";
import _ from "lodash";
import { Link } from "react-router";
import Nav from "../Nav/Nav";
import Footer from "../Footer/Footer";
import FooterData from "../../../strings/footer";


class LanderContainer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  static propTypes = {
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
  };

  render() {
    return (
      <div>
        <Nav />
        <main className="mt5 mt6-l">
          {this.props.children}    
        </main>
        <Footer social={FooterData.footer.social} content={FooterData.footer.groups} data={FooterData.footer} />
      </div>
    );
  }
}

export default LanderContainer;
