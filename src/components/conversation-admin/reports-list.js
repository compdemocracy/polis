// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import Awesome from "react-fontawesome";
import ConversationHasCommentsCheck from "./conversation-has-comments-check";
import Highlight from "react-highlight";
import PolisNet from "../../util/net";
import Radium from "radium";
import React from "react";
import { connect } from "react-redux";
import { Link } from "react-router";


const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: "10px 10px",
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}

@connect(state => state.zid_metadata)
@Radium
class ReportsList extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      loading: true,
      reports: [],
    };
  }

  getData() {
    let reportsPromise = PolisNet.polisGet("/api/v3/reports", {
      conversation_id: this.props.params.conversation_id,
    });
    reportsPromise.then((reports) => {
      this.setState({
        loading: false,
        reports: reports,
      });
    });
  }

  componentWillMount() {
    this.getData();
  }

  createReportClicked() {
    PolisNet.polisPost("/api/v3/reports", {
      conversation_id: this.props.params.conversation_id,
    }).then(() => {
      this.getData();
    });
  }

  render() {
    if (this.state.loading) {
      return <div>Loading Reports...</div>;
    }
    return (
      <div>
        <h1>Reports</h1>
        {this.state.reports.map((report) => {
          return (<div style={styles.card} key={report.report_id}>
            {report.report_id}
            {' '}
            <Link
              to={"/m/" + this.props.params.conversation_id + "/reports/" + report.report_id}
              style={styles.base}>
              <Awesome style={{marginRight: 10}} name="gears"/>
              Edit
            </Link>
            {' '}
            <a href={"/reports/" + report.report_id}>View</a>
          </div>);
        })}
        <div style={styles.card} onClick={this.createReportClicked.bind(this)}>Create New Report</div>
      </div>
    );
  }
}
            // <Link
            //   to={"/reports/" + report.report_id}
            //   style={styles.base}>
            //   View
            // </Link>

export default ReportsList;

