// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import PropTypes from "prop-types";
import { connect } from "react-redux";
import Nav from "../Nav/Nav";
import Footer from "../Footer/Footer";
import FooterData from "../../../strings/footer";


class LanderContainer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  static propTypes = {
    params: PropTypes.object,
    routes: PropTypes.array,
  };

  render() {
    return (
      <div>
        <Nav />
        <main className="pt5 pt4-m pt0-l mt5 mt6-l">
          {this.props.children}    
        </main>
        <Footer social={FooterData.footer.social} content={FooterData.footer.groups} data={FooterData.footer} />
      </div>
    );
  }
}

export default LanderContainer;
