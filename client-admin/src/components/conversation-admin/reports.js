// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import ComponentHelpers from "../../util/component-helpers";
import Flex from "../framework/flex";
import NavTab from "../framework/nav-tab";
import NoPermission from "./no-permission";
import Radium from "radium";
import React from "react";
import { connect } from "react-redux";
import { Link } from "react-router";
import { populateAllCommentStores } from "../../actions";

@Radium
class Reports extends React.Component {
  componentWillMount() {
  }
  componentDidMount() {
  }
  componentWillUnmount() {
  }
  render() {
    return (
      <div>
        {this.props.children}
      </div>
    );
  }
}

export default Reports;
