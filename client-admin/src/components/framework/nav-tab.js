// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Link } from "react-router-dom";

import React from "react";
import Radium from "radium";
// import _ from 'lodash';
// import Flex from './framework/flex';
// import { connect } from 'react-redux';
// import { FOO } from '../actions';

// const style = {
// };

// @connect(state => {
//   return state.FOO;
// })
@Radium
class NavTab extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  getStyles() {
    return {
      navTabs: {
        cursor: "pointer",
        padding: 14,
        fontWeight: 700,
        textDecoration: "none",
        color: "rgb(180,180,180)",
        borderBottom: "3px solid transparent" /* avoids height glitch */,
      },
      active: {
        borderBottom: "3px solid rgb(100,100,100)",
        color: "rgb(100,100,100)",
      },
      tabText: {
        display: "inline-block",
      },
      number: {
        padding: "3px 6px",
        backgroundColor: "white",
        borderRadius: 3,
        fontWeight: 300,
        display: "inline-block",
        fontSize: 14,
        marginLeft: 7,
      },
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Link
        onlyActiveOnIndex
        activeStyle={styles.active}
        style={styles.navTabs}
        to={this.props.url}
      >
        <span style={styles.tabText}> {this.props.text} </span>
        {this.props.number ? <span style={styles.number}> {this.props.number} </span> : ""}
      </Link>
    );
  }
}

export default NavTab;
