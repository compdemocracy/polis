// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import ComponentHelpers from "../../util/component-helpers";
import Flex from "../framework/flex";
import NavTab from "../framework/nav-tab";
import NoPermission from "./no-permission";
import PolisNet from "../../util/net";
import Radium from "radium";
import React from "react";
import InputField from "material-ui/lib/text-field";

import { connect } from "react-redux";
import { Link } from "react-router";
import { populateAllCommentStores } from "../../actions";

const cardPadding = 10;
const cardBorderRadius = 3;

const styles = {
  container: {
    backgroundColor: "rgb(240,240,247)",
    minHeight: "100vh",
    paddingBottom: 10
  },
  configCard: {
    margin: 10,
    maxWidth: 400,
    backgroundColor: "rgb(253,253,253)",
    borderRadius: cardBorderRadius,
    padding: cardPadding,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  sectionHeader: {
    fontSize: 22,
    marginTop: 0,
    marginBottom: 0,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  },
  notification: {
    fontSize: 16,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  }
}

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
  handleStringValueChange (field) {
    return () => {
      var val = this.refs[field].getValue();
      if (field === "help_bgcolor" || field === "help_color") {
        if (!val.length) {
          val = "default";
        }
      }
      this.props.dispatch(
        handleZidMetadataUpdate(
          this.props.zid_metadata,
          field,
          this.refs[field].getValue()
        )
      )
    }
  }

  handleConfigInputTyping (field) {
    return (e) => {
      this.props.dispatch(
        optimisticZidMetadataUpdateOnTyping(
          this.props.zid_metadata,
          field,
          e.target.value
        )
      )
    }
  }

  createMarkup() {
    return (
      <div>
        {/* error and loading may go here - see conversation-config.js */}
        <div style={styles.configCard}>
          <p style={styles.sectionHeader}>Report {this.props.params.report_id}</p>
          <InputField
            ref={"report_name"}
            style={{width: 360}}
            onBlur={this.handleStringValueChange("report_name").bind(this)}
            onChange={this.handleConfigInputTyping("report_name")}
            value={""}
            hintText="ie., 'Monthly check-in (August)'"
            floatingLabelText={"Report name"}
            multiLine={true} />
        </div>

        <div style={styles.configCard}>
          <p style={styles.sectionHeader}> Create axis labels </p>
          <div>
            <InputField
              ref={"label_x_neg"}
              style={{width: 360}}
              onBlur={this.handleStringValueChange("label_x_neg").bind(this)}
              onChange={this.handleConfigInputTyping("label_x_neg")}
              value={this.state.report["label_x_neg"]}
              hintText="ie., 'In favor of more regulation'"
              floatingLabelText={"Label for negative x axis (←)"}
              multiLine={true} />
            <InputField
              ref={"label_x_pos"}
              style={{width: 360}}
              onBlur={this.handleStringValueChange("label_x_pos").bind(this)}
              onChange={this.handleConfigInputTyping("label_x_pos")}
              value={this.state.report["label_x_pos"]}
              hintText="ie., 'Opposed to more regulation'"
              floatingLabelText={"Label for positive x axis (→)"}
              multiLine={true} />
            <InputField
              ref={"label_y_neg"}
              style={{width: 360}}
              onBlur={this.handleStringValueChange("label_y_neg").bind(this)}
              onChange={this.handleConfigInputTyping("label_y_neg")}
              value={this.state.report["label_y_neg"]}
              hintText="ie., 'Individuals are responsible'"
              floatingLabelText={"Label for negative y axis (↓)"}
              multiLine={true} />
            <InputField
              ref={"label_y_pos"}
              style={{width: 360}}
              onBlur={this.handleStringValueChange("label_y_pos").bind(this)}
              onChange={this.handleConfigInputTyping("label_y_pos")}
              value={this.state.report["label_y_pos"]}
              hintText="ie., 'Society is responsible'"
              floatingLabelText={"Label for positive y axis (↑)"}
              multiLine={true} />
          </div>
        </div>
        <div style={styles.configCard}>
          <p style={styles.sectionHeader}> Create group nicknames </p>
          <div>
            {
              /* we have 10 groups max hardcoded for now */
              [0,1,2,3,4,5,6,7,8,9].map((d, i) => {
                if (!this.state.report["label_group_" + i]) {return}
                return (
                  <InputField
                    ref={"label_group_" + i}
                    style={{width: 360}}
                    onBlur={this.handleStringValueChange("label_group_" + i).bind(this)}
                    onChange={this.handleConfigInputTyping("label_group_" + i)}
                    value={this.state.report["label_group_" + i]}
                    hintText="ie., 'Dog lovers'"
                    floatingLabelText={"Group "+ i +" nickname"}
                    multiLine={true} />
                )
              })
            }
          </div>
        </div>
      {/* container */} </div>
    )
  }

  render() {
    return (
      <div style={styles.container}>
        {this.state.report ? this.createMarkup() : "Loading"}
      </div>
    );
  }
}

export default ReportConfig;

// {
//   "report_id":"r6ehukhk29tcfmuc57vrj",
//   "created":"1488835750478",
//   "modified":"1488925945969",
//   "label_x_neg":"label_x_neg",
//   "label_y_neg":"label_y_neg",
//   "label_y_pos":"label_y_pos",
//   "label_x_pos":"label_x_pos",
//   "label_group_0":"label_group_0",
//   "label_group_1":"label_group_1",
//   "label_group_2":"label_group_2",
//   "label_group_3":"label_group_3",
//   "label_group_4":null,
//   "label_group_5":null,
//   "label_group_6":null,
//   "label_group_7":null,
//   "label_group_8":null,
//   "label_group_9":null,
//   "conversation_id":"36jajfnhhn"
// }
