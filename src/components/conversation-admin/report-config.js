// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import ComponentHelpers from "../../util/component-helpers";
import Flex from "../framework/flex";
import NavTab from "../framework/nav-tab";
import NoPermission from "./no-permission";
import PolisNet from "../../util/net";
import Radium from "radium";
import React from "react";
import { connect } from "react-redux";
import { Link } from "react-router";
import { populateAllCommentStores } from "../../actions";

@Radium
class ReportConfig extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      loading: true,
      report: null,
    };
  }

  getData() {
    let reportsPromise = PolisNet.polisGet("/api/v3/reports", {
      report_id: this.props.params.report_id,
    });
    reportsPromise.then((reports) => {
      this.setState({
        loading: false,
        report: reports[0],
      });
    });
  }

  componentWillMount() {
    this.getData();
  }

  render() {
    return (
      <div>
        Config for report: {this.props.params.report_id}
        {JSON.stringify(this.state.report)}
      </div>
    );
  }
}

export default ReportConfig;
